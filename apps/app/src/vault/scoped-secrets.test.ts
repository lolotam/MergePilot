import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeTargetKey } from '@mergepilot/webscan';
import { EnvelopeVault } from './envelope-vault.js';
import { VaultError } from './envelope.js';
import { reencryptAll, type ScannerEnvelopeStore } from './rotate.js';
import { MemoryScannerEnvelopeStore } from './rotate.test-helpers.js';
import { PurposeScopedVault, WEBSCAN_IDENTITY_PURPOSE } from './scoped-secrets.js';

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const ring = new Map<number, Buffer>([
  [1, key1],
  [2, key2],
]);

/** A store that only carries the scanner envelopes, so the rotation has nothing else to touch. */
function scannerStore(envelopes: { siteId: string; ciphertext: string; keyVersion: number }[]) {
  return new MemoryScannerEnvelopeStore(envelopes);
}

describe('the purpose-scoped secret vault', () => {
  it('opens a secret only with the purpose and the scope it was sealed with', async () => {
    const vault = new PurposeScopedVault({ current: 1, keys: ring });
    const context = { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: 'site-1' };

    const ciphertext = await vault.seal('the identity key', context);

    expect(ciphertext.startsWith('s1.1.')).toBe(true);
    expect(await vault.open(ciphertext, context)).toBe('the identity key');
  });

  it('refuses the wrong site and the wrong purpose', async () => {
    const vault = new PurposeScopedVault({ current: 1, keys: ring });
    const ciphertext = await vault.seal('the identity key', {
      purpose: WEBSCAN_IDENTITY_PURPOSE,
      scopeId: 'site-1',
    });

    await expect(
      vault.open(ciphertext, { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: 'site-2' }),
    ).rejects.toBeInstanceOf(VaultError);
    await expect(
      vault.open(ciphertext, { purpose: 'some-other-purpose', scopeId: 'site-1' }),
    ).rejects.toBeInstanceOf(VaultError);
  });

  it('never opens a provider credential and is never opened by one', async () => {
    const providerVault = new EnvelopeVault({ current: 1, keys: ring });
    const scopedVault = new PurposeScopedVault({ current: 1, keys: ring });

    const credential = await providerVault.encrypt('sk-provider-secret', {
      workspaceId: 'ws-1',
      provider: 'anthropic',
    });
    const secret = await scopedVault.seal('scanner-secret', {
      purpose: WEBSCAN_IDENTITY_PURPOSE,
      scopeId: 'site-1',
    });

    await expect(
      scopedVault.open(credential, { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: 'ws-1' }),
    ).rejects.toBeInstanceOf(VaultError);
    await expect(
      scopedVault.open(credential, { purpose: 'anthropic', scopeId: 'ws-1' }),
    ).rejects.toBeInstanceOf(VaultError);
    await expect(
      providerVault.decrypt(secret, { workspaceId: 'site-1', provider: 'anthropic' }),
    ).rejects.toBeInstanceOf(VaultError);
  });

  it('keeps the key version of the envelope so a rotation can find the stale ones', async () => {
    const vaultV1 = new PurposeScopedVault({ current: 1, keys: ring });
    const vaultV2 = new PurposeScopedVault({ current: 2, keys: ring });
    const context = { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: 'site-1' };

    const old = await vaultV1.seal('the identity key', context);
    expect(old.split('.')[1]).toBe('1');

    const rotated = await vaultV2.seal(await vaultV1.open(old, context), context);
    expect(rotated.split('.')[1]).toBe('2');
    expect(await vaultV2.open(rotated, context)).toBe('the identity key');
  });
});

describe('the master-key rotation', () => {
  it('rewraps the scanner identity envelopes and keeps the identity key and its HMAC output', async () => {
    const providerVaultV1 = new EnvelopeVault({ current: 1, keys: ring });
    const providerVaultV2 = new EnvelopeVault({ current: 2, keys: ring });
    const scopedVaultV1 = new PurposeScopedVault({ current: 1, keys: ring });
    const scopedVaultV2 = new PurposeScopedVault({ current: 2, keys: ring });

    const identityKey = randomBytes(32).toString('base64');
    const context = { purpose: WEBSCAN_IDENTITY_PURPOSE, scopeId: 'site-1' };
    const envelope = await scopedVaultV1.seal(identityKey, context);
    const store = scannerStore([{ siteId: 'site-1', ciphertext: envelope, keyVersion: 1 }]);

    const before = computeTargetKey('https://example.com/path', Buffer.from(identityKey, 'base64'));

    const result = await reencryptAll(
      { listCredentials: async () => [], listProviderKeys: async () => [] } as never,
      providerVaultV2,
      [],
      { store, vault: scopedVaultV2 },
    );

    expect(result.scannerReencrypted).toBe(1);
    expect(result.scannerSkipped).toBe(0);

    const [rotated] = await store.listIdentityEnvelopes();
    expect(rotated?.keyVersion).toBe(2);
    expect(rotated?.ciphertext).not.toBe(envelope);

    // The sealed bytes are the same, so every identity derived from them is the same.
    const opened = await scopedVaultV2.open(rotated!.ciphertext, context);
    expect(opened).toBe(identityKey);
    expect(computeTargetKey('https://example.com/path', Buffer.from(opened, 'base64'))).toBe(before);

    // The old master key can be retired: an envelope that holds only the old key
    // cannot open the rotated one any more.
    const onlyOldKey = new PurposeScopedVault({ current: 1, keys: new Map([[1, key1]]) });
    await expect(onlyOldKey.open(rotated!.ciphertext, context)).rejects.toBeInstanceOf(VaultError);
    expect(providerVaultV1.keyVersion).toBe(1);
  });

  it('counts an envelope that is already current as skipped', async () => {
    const providerVault = new EnvelopeVault({ current: 2, keys: ring });
    const scopedVault = new PurposeScopedVault({ current: 2, keys: ring });
    const envelope = await scopedVault.seal('the identity key', {
      purpose: WEBSCAN_IDENTITY_PURPOSE,
      scopeId: 'site-1',
    });
    const store = scannerStore([{ siteId: 'site-1', ciphertext: envelope, keyVersion: 2 }]);

    const result = await reencryptAll(
      { listCredentials: async () => [], listProviderKeys: async () => [] } as never,
      providerVault,
      [],
      { store, vault: scopedVault },
    );

    expect(result.scannerReencrypted).toBe(0);
    expect(result.scannerSkipped).toBe(1);
    expect((await store.listIdentityEnvelopes())[0]?.ciphertext).toBe(envelope);
  });

  it('refuses to run when the two vaults disagree on the key version', async () => {
    const providerVault = new EnvelopeVault({ current: 2, keys: ring });
    const scopedVault = new PurposeScopedVault({ current: 1, keys: ring });

    await expect(
      reencryptAll(
        { listCredentials: async () => [], listProviderKeys: async () => [] } as never,
        providerVault,
        [],
        { store: scannerStore([]), vault: scopedVault },
      ),
    ).rejects.toThrow(/does not match/);
  });

  it('fails the rotation when a scanner envelope cannot be opened', async () => {
    const providerVault = new EnvelopeVault({ current: 2, keys: ring });
    const scopedVault = new PurposeScopedVault({ current: 2, keys: ring });
    const broken: ScannerEnvelopeStore = {
      listIdentityEnvelopes: async () => [
        { siteId: 'site-1', ciphertext: 's1.1.broken', keyVersion: 1 },
      ],
      saveIdentityEnvelope: async () => undefined,
    };

    await expect(
      reencryptAll(
        { listCredentials: async () => [], listProviderKeys: async () => [] } as never,
        providerVault,
        [],
        { store: broken, vault: scopedVault },
      ),
    ).rejects.toBeInstanceOf(VaultError);
  });
});

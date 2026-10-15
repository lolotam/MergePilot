import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSubscription, encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { CredentialService } from '../credentials/service.js';
import { EnvelopeVault } from './envelope-vault.js';
import { reencryptAll } from './rotate.js';

const fakeValue = (...parts: string[]) => parts.join('-');

/** A v1 store holding one xai subscription (no key slots), and a v2 vault for rotation. */
async function subscriptionFixture(expires: number) {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
  const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
  const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
  const store = new MemoryStore();
  const service = new CredentialService({ store, vault: vaultV1 });
  const sub: SubscriptionCredential = {
    type: 'oauth', access: fakeValue('old', 'access', '1111'), refresh: fakeValue('old', 'refresh'), expires,
  };
  await service.saveSubscription('ws', 'xai', sub, 'u');
  expect(await store.listProviderKeys('ws', 'xai')).toEqual([]);
  return { store, service, vaultV1, vaultV2, onlyV2, sub };
}

/** Runs `concurrent` once, just before the next locked credential change, as another process would. */
function beforeNextCredentialLock(store: MemoryStore, concurrent: () => Promise<unknown>) {
  let ran = false;
  const modify = store.modifyCredential.bind(store);
  vi.spyOn(store, 'modifyCredential').mockImplementation(async (workspaceId, provider, change, signal) => {
    if (!ran) {
      ran = true;
      await concurrent();
    }
    return modify(workspaceId, provider, change, signal);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reencryptAll', () => {
  it('re-wraps credentials whose keyVersion is old and updates the store', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);

    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const store = new MemoryStore();

    // Store a credential with keyVersion 1
    const rawPlaintext = 'sk-ant-api03-rotate-test-key-001';
    const ciphertextV1 = await vaultV1.encrypt(rawPlaintext, {
      workspaceId: 'ws-1',
      provider: 'anthropic',
    });

    await store.saveCredential({
      id: 'cred-1',
      workspaceId: 'ws-1',
      provider: 'anthropic',
      ciphertext: ciphertextV1,
      keyVersion: 1,
      last4: rawPlaintext.slice(-4),
      createdBy: 'user-1',
      createdAt: new Date(),
    });

    // Another credential that is already on current keyVersion 2
    const vaultV2 = new EnvelopeVault({
      current: 2,
      keys: new Map([
        [1, key1],
        [2, key2],
      ]),
    });

    const ciphertextV2 = await vaultV2.encrypt('openai-key-already-v2', {
      workspaceId: 'ws-1',
      provider: 'openai',
    });

    await store.saveCredential({
      id: 'cred-2',
      workspaceId: 'ws-1',
      provider: 'openai',
      ciphertext: ciphertextV2,
      keyVersion: 2,
      last4: 'y-v2',
      createdBy: 'user-1',
      createdAt: new Date(),
    });

    // Credential for another workspace ws-2
    await store.saveCredential({
      id: 'cred-3',
      workspaceId: 'ws-2',
      provider: 'gemini',
      ciphertext: await vaultV1.encrypt('gemini-key-ws-2', { workspaceId: 'ws-2', provider: 'gemini' }),
      keyVersion: 1,
      last4: 'ws-2',
      createdBy: 'user-2',
      createdAt: new Date(),
    });

    // Re-encrypt only ws-1
    const result = await reencryptAll(store, vaultV2, ['ws-1']);
    expect(result.reencrypted).toBe(1);
    expect(result.skipped).toBe(1);

    // Verify cred-1 is re-encrypted with keyVersion 2
    const updatedCred1 = await store.getCredential('ws-1', 'anthropic');
    expect(updatedCred1).not.toBeNull();
    expect(updatedCred1?.keyVersion).toBe(2);
    expect(updatedCred1?.ciphertext.startsWith('v1.2.')).toBe(true);

    // Verify it can now be decrypted by a vault having ONLY key 2
    const vaultOnlyV2 = new EnvelopeVault({
      current: 2,
      keys: new Map([[2, key2]]),
    });
    const decryptedWithOnlyKey2 = await vaultOnlyV2.decrypt(updatedCred1!.ciphertext, {
      workspaceId: 'ws-1',
      provider: 'anthropic',
    });
    expect(decryptedWithOnlyKey2).toBe(rawPlaintext);

    // Verify cred-3 in ws-2 was NOT modified (workspace isolation during rotation)
    const cred3 = await store.getCredential('ws-2', 'gemini');
    expect(cred3?.keyVersion).toBe(1);
    expect(cred3?.ciphertext.startsWith('v1.1.')).toBe(true);
  });

  it('does not recreate credentials of a workspace deleted mid-rotation', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    await store.saveCredential({
      id: 'cred-del',
      workspaceId: 'ws-del',
      provider: 'anthropic',
      ciphertext: await vaultV1.encrypt('plain-value', { workspaceId: 'ws-del', provider: 'anthropic' }),
      keyVersion: 1,
      last4: 'alue',
      createdBy: 'user-1',
      createdAt: new Date(),
    });
    beforeNextCredentialLock(store, () => store.deleteWorkspace('ws-del'));

    const result = await reencryptAll(store, vaultV2, ['ws-del']);

    expect(result).toEqual({ reencrypted: 0, skipped: 0 });
    expect(await store.listCredentials('ws-del')).toEqual([]);
  });

  it('counts every already-current key of a multi-key list as skipped', async () => {
    const key1 = randomBytes(32);
    const vault = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault });
    await service.saveKeyList({
      workspaceId: 'ws-current',
      provider: 'gemini',
      apiKeys: ['gemini-current-key-aaaa-1111', 'gemini-current-key-bbbb-2222'],
      userId: 'u',
    });

    expect(await reencryptAll(store, vault, ['ws-current'])).toEqual({ reencrypted: 0, skipped: 2 });
  });

  it('does not resurrect a deleted multi-key credential via the outer parent branch', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault: vaultV1 });
    await service.saveKeyList({
      workspaceId: 'ws-gone',
      provider: 'gemini',
      apiKeys: ['gemini-rotate-key-aaaa-1111', 'gemini-rotate-key-bbbb-2222'],
      userId: 'u',
    });
    const slots = await store.listProviderKeys('ws-gone', 'gemini');
    for (const slot of slots) {
      await service.deleteProviderKey('ws-gone', 'gemini', slot.id);
    }
    expect(await store.getCredential('ws-gone', 'gemini')).toBeNull();

    const listCredentials = store.listCredentials.bind(store);
    vi.spyOn(store, 'listCredentials').mockImplementation(async (workspaceId) => {
      const rows = await listCredentials(workspaceId);
      if (workspaceId === 'ws-gone' && rows.length === 0) {
        return [
          {
            id: 'stale-parent',
            workspaceId: 'ws-gone',
            provider: 'gemini',
            keyVersion: 1,
            last4: '1111',
            createdBy: 'u',
            createdAt: new Date(),
          },
        ];
      }
      return rows;
    });

    await reencryptAll(store, vaultV2, ['ws-gone']);

    expect(await store.getCredential('ws-gone', 'gemini')).toBeNull();
    expect(await store.listProviderKeys('ws-gone', 'gemini')).toEqual([]);
  });

  it('re-encrypts from the locked slot snapshot so append and delete before rotation stay applied', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault: vaultV1 });
    const first = 'gemini-rotate-key-aaaa-1111';
    const second = 'gemini-rotate-key-bbbb-2222';
    const third = 'gemini-rotate-key-cccc-3333';
    await service.saveKeyList({ workspaceId: 'ws-rot', provider: 'gemini', apiKeys: [first, second], userId: 'u' });
    const before = await store.listProviderKeys('ws-rot', 'gemini');
    const deleteId = before[0]!.id;
    await service.appendProviderKey({ workspaceId: 'ws-rot', provider: 'gemini', apiKey: third, userId: 'u' });
    await service.deleteProviderKey('ws-rot', 'gemini', deleteId);

    let lockedSlotCount = 0;
    const modify = store.modifyProviderKeys.bind(store);
    vi.spyOn(store, 'modifyProviderKeys').mockImplementation(async (workspaceId, provider, change) =>
      modify(workspaceId, provider, async (current, parent) => {
        lockedSlotCount = current.length;
        return change(current, parent);
      }),
    );

    const result = await reencryptAll(store, vaultV2, ['ws-rot']);
    expect(result.reencrypted).toBeGreaterThan(0);
    expect(lockedSlotCount).toBe(2);

    const slots = await store.listProviderKeys('ws-rot', 'gemini');
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.keyVersion)).toEqual([2, 2]);
    const parent = await store.getCredential('ws-rot', 'gemini');
    expect(parent?.id).toBe(slots[0]?.id);
    expect(parent?.keyVersion).toBe(2);
    expect(slots.some((slot) => slot.last4 === first.slice(-4))).toBe(false);
    const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
    const plain = await onlyV2.decrypt(slots[0]!.ciphertext, { workspaceId: 'ws-rot', provider: 'gemini' });
    expect([second, third]).toContain(plain);
  });

  it('applies concurrent slot changes before the modify callback and never calls getCredential inside it', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault: vaultV1 });
    const first = 'gemini-rotate-key-aaaa-1111';
    const second = 'gemini-rotate-key-bbbb-2222';
    const third = 'gemini-rotate-key-cccc-3333';
    await service.saveKeyList({ workspaceId: 'ws-race', provider: 'gemini', apiKeys: [first, second], userId: 'u' });

    let insideModifyCallback = false;
    let concurrentRan = false;
    const getCredential = store.getCredential.bind(store);
    vi.spyOn(store, 'getCredential').mockImplementation(async (workspaceId, provider) => {
      if (insideModifyCallback) {
        throw new Error('getCredential must not run inside modifyProviderKeys');
      }
      return getCredential(workspaceId, provider);
    });

    const modify = store.modifyProviderKeys.bind(store);
    vi.spyOn(store, 'modifyProviderKeys').mockImplementation(async (workspaceId, provider, change) => {
      if (provider === 'gemini' && workspaceId === 'ws-race' && !concurrentRan) {
        concurrentRan = true;
        await service.appendProviderKey({ workspaceId, provider: 'gemini', apiKey: third, userId: 'u' });
      }
      return modify(workspaceId, provider, async (current, parent) => {
        insideModifyCallback = true;
        try {
          return await change(current, parent);
        } finally {
          insideModifyCallback = false;
        }
      });
    });

    await reencryptAll(store, vaultV2, ['ws-race']);

    const slots = await store.listProviderKeys('ws-race', 'gemini');
    expect(slots).toHaveLength(3);
    expect(slots.every((slot) => slot.keyVersion === 2)).toBe(true);
    const parent = await store.getCredential('ws-race', 'gemini');
    expect(parent?.id).toBe(slots[0]?.id);
    expect(parent?.keyVersion).toBe(2);
    const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
    const thirdSlot = slots.find((slot) => slot.last4 === third.slice(-4));
    expect(thirdSlot).toBeDefined();
    const thirdPlain = await onlyV2.decrypt(thirdSlot!.ciphertext, { workspaceId: 'ws-race', provider: 'gemini' });
    expect(thirdPlain).toBe(third);
  });

  it('re-encrypts a subscription parent when slots were emptied before rotation', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault: vaultV1 });
    const sub: SubscriptionCredential = {
      type: 'oauth',
      access: ['test', 'access', '1111'].join('-'),
      refresh: ['test', 'refresh'].join('-'),
      expires: Date.now() + 3_600_000,
    };
    await service.saveSubscription('ws-sub', 'openai', sub, 'u');
    const added = await service.appendProviderKey({
      workspaceId: 'ws-sub',
      provider: 'openai',
      apiKey: ['sk', 'openai', 'rotate', '0001'].join('-'),
      userId: 'u',
    });
    expect(await store.listProviderKeys('ws-sub', 'openai')).toHaveLength(1);

    let emptiedDuringRotate = false;
    const modify = store.modifyProviderKeys.bind(store);
    vi.spyOn(store, 'modifyProviderKeys').mockImplementation(async (workspaceId, provider, change) => {
      if (provider === 'openai' && workspaceId === 'ws-sub' && !emptiedDuringRotate) {
        emptiedDuringRotate = true;
        await service.deleteProviderKey(workspaceId, 'openai', added.id);
      }
      return modify(workspaceId, provider, change);
    });

    const parentBefore = await store.getCredential('ws-sub', 'openai');
    expect(parentBefore?.keyVersion).toBe(1);
    const plainSub = await vaultV1.decrypt(parentBefore!.ciphertext, { workspaceId: 'ws-sub', provider: 'openai' });
    expect(plainSub).toContain('mergepilot:oauth');

    const encrypt = vi.spyOn(vaultV2, 'encrypt');
    await reencryptAll(store, vaultV2, ['ws-sub']);
    expect(encrypt).toHaveBeenCalled();

    const parentAfter = await store.getCredential('ws-sub', 'openai');
    expect(parentAfter?.keyVersion).toBe(2);
    const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
    const rotated = await onlyV2.decrypt(parentAfter!.ciphertext, { workspaceId: 'ws-sub', provider: 'openai' });
    expect(encodeSubscription('openai', sub)).toBe(rotated);
  });

  it('keeps a readable subscription parent and re-encrypts its API key slots', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const store = new MemoryStore();
    const { CredentialService } = await import('../credentials/service.js');
    const service = new CredentialService({ store, vault: vaultV1 });
    const sub: SubscriptionCredential = {
      type: 'oauth',
      access: ['test', 'access', '2222'].join('-'),
      refresh: ['test', 'refresh'].join('-'),
      expires: Date.now() + 3_600_000,
    };
    const apiKey = ['fake', 'anthropic', 'slot', '0001'].join('-');
    await service.saveSubscription('ws-both', 'anthropic', sub, 'u');
    await service.appendProviderKey({ workspaceId: 'ws-both', provider: 'anthropic', apiKey, userId: 'u' });

    await reencryptAll(store, vaultV2, ['ws-both']);

    const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
    const context = { workspaceId: 'ws-both', provider: 'anthropic' } as const;
    const parent = await store.getCredential('ws-both', 'anthropic');
    expect(parent?.keyVersion).toBe(2);
    expect(await onlyV2.decrypt(parent!.ciphertext, context)).toBe(encodeSubscription('anthropic', sub));
    const [slot] = await store.listProviderKeys('ws-both', 'anthropic');
    expect(slot?.keyVersion).toBe(2);
    expect(await onlyV2.decrypt(slot!.ciphertext, context)).toBe(apiKey);
  });

  it('keeps a subscription token refreshed concurrently with rotation instead of the stale read', async () => {
    const { store, service, vaultV2, onlyV2 } = await subscriptionFixture(0);
    const fetchMock = vi.fn(async () => Response.json({
      access_token: fakeValue('new', 'access', '2222'), refresh_token: fakeValue('new', 'refresh'), expires_in: 3600,
    }));
    vi.stubGlobal('fetch', fetchMock);
    beforeNextCredentialLock(store, () => service.resolve('ws', 'xai'));

    const result = await reencryptAll(store, vaultV2, ['ws']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reencrypted: 1, skipped: 0 });
    const stored = await store.getCredential('ws', 'xai');
    expect(stored?.keyVersion).toBe(2);
    expect(stored?.last4).toBe('2222');
    const envelope = decodeSubscription(await onlyV2.decrypt(stored!.ciphertext, { workspaceId: 'ws', provider: 'xai' }), 'xai');
    expect(envelope?.credential.access).toBe(fakeValue('new', 'access', '2222'));
    expect(envelope?.credential.refresh).toBe(fakeValue('new', 'refresh'));
  });

  it('does not resurrect a single-key credential disconnected during rotation', async () => {
    const { store, service, vaultV2 } = await subscriptionFixture(Date.now() + 3_600_000);
    beforeNextCredentialLock(store, () => service.deleteKey('ws', 'xai'));

    const result = await reencryptAll(store, vaultV2, ['ws']);

    expect(result).toEqual({ reencrypted: 0, skipped: 0 });
    expect(await store.getCredential('ws', 'xai')).toBeNull();
    expect(await store.listCredentials('ws')).toEqual([]);
  });

  it('writes nothing and leaks no token when re-encryption fails inside the lock', async () => {
    const { store, vaultV1, vaultV2, sub } = await subscriptionFixture(Date.now() + 3_600_000);
    const before = await store.getCredential('ws', 'xai');
    vi.spyOn(vaultV2, 'encrypt').mockRejectedValue(new Error('vault unavailable'));

    const error: unknown = await reencryptAll(store, vaultV2, ['ws']).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const surfaced = `${String(error)}\n${(error as Error).stack ?? ''}`;
    expect(surfaced).not.toContain(sub.access);
    expect(surfaced).not.toContain(sub.refresh);
    expect(await store.getCredential('ws', 'xai')).toEqual(before);
    const plain = await vaultV1.decrypt(before!.ciphertext, { workspaceId: 'ws', provider: 'xai' });
    expect(plain).toBe(encodeSubscription('xai', sub));
  });
});

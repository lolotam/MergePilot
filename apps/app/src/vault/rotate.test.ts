import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from './envelope-vault.js';
import { reencryptAll } from './rotate.js';

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
});

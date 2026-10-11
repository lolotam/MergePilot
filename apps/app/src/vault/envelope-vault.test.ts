import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvelopeVault, VaultError } from './envelope-vault.js';

describe('EnvelopeVault', () => {
  const masterKey32 = randomBytes(32).toString('base64');
  const otherMasterKey32 = randomBytes(32).toString('base64');

  describe('constructor & key validation', () => {
    it('accepts a valid 32-byte base64 string', () => {
      const vault = new EnvelopeVault(masterKey32);
      expect(vault.keyVersion).toBe(1);
    });

    it('accepts options with masterKey and keyVersion', () => {
      const vault = new EnvelopeVault({ masterKey: masterKey32, keyVersion: 3 });
      expect(vault.keyVersion).toBe(3);
    });

    it('accepts options with current and Map of keys', () => {
      const keys = new Map<number, Buffer>([
        [1, Buffer.from(masterKey32, 'base64')],
        [2, Buffer.from(otherMasterKey32, 'base64')],
      ]);
      const vault = new EnvelopeVault({ current: 2, keys });
      expect(vault.keyVersion).toBe(2);
    });

    it('rejects an invalid master key without echoing the value', () => {
      const sensitiveBadKey = 'secret-short-key-12345';
      let errorThrown: Error | null = null;
      try {
        new EnvelopeVault(sensitiveBadKey);
      } catch (err) {
        errorThrown = err as Error;
      }
      expect(errorThrown).not.toBeNull();
      expect(errorThrown?.message).not.toContain(sensitiveBadKey);
      expect(errorThrown?.message).toMatch(/master key/i);
    });

    it('rejects an empty or non-32-byte base64 master key without echoing it', () => {
      const badBase64 = Buffer.from('only-16-bytes!!!').toString('base64');
      expect(() => new EnvelopeVault(badBase64)).toThrow(/master key/i);
      expect(() => new EnvelopeVault(badBase64)).not.toThrow(badBase64);
    });

    it('rejects when current version key is missing in Map', () => {
      const keys = new Map<number, Buffer>([[1, Buffer.from(masterKey32, 'base64')]]);
      expect(() => new EnvelopeVault({ current: 2, keys })).toThrow(/missing/i);
    });
  });

  describe('encrypt and decrypt (round trip)', () => {
    it('successfully encrypts and decrypts plaintext', async () => {
      const vault = new EnvelopeVault(masterKey32);
      const plaintext = 'sk-ant-api03-test-secret-key-xyz-1234567890';
      const context = { workspaceId: 'ws-123', provider: 'anthropic' as const };

      const ciphertext = await vault.encrypt(plaintext, context);
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.startsWith('v1.1.')).toBe(true);

      const decrypted = await vault.decrypt(ciphertext, context);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('AAD binding', () => {
    it('fails to decrypt if workspaceId differs', async () => {
      const vault = new EnvelopeVault(masterKey32);
      const plaintext = 'secret-data';
      const ciphertext = await vault.encrypt(plaintext, { workspaceId: 'ws-A', provider: 'openai' });

      await expect(
        vault.decrypt(ciphertext, { workspaceId: 'ws-B', provider: 'openai' }),
      ).rejects.toThrow(VaultError);
      await expect(
        vault.decrypt(ciphertext, { workspaceId: 'ws-B', provider: 'openai' }),
      ).rejects.toThrow('decryption failed');
    });

    it('fails to decrypt if provider differs', async () => {
      const vault = new EnvelopeVault(masterKey32);
      const plaintext = 'secret-data';
      const ciphertext = await vault.encrypt(plaintext, { workspaceId: 'ws-A', provider: 'openai' });

      await expect(
        vault.decrypt(ciphertext, { workspaceId: 'ws-A', provider: 'anthropic' }),
      ).rejects.toThrow(VaultError);
      await expect(
        vault.decrypt(ciphertext, { workspaceId: 'ws-A', provider: 'anthropic' }),
      ).rejects.toThrow('decryption failed');
    });
  });

  describe('tamper resistance', () => {
    it('fails to decrypt if any character of the ciphertext is modified', async () => {
      const vault = new EnvelopeVault(masterKey32);
      const context = { workspaceId: 'ws-123', provider: 'gemini' as const };
      const ciphertext = await vault.encrypt('gemini-secret-api-key', context);

      const parts = ciphertext.split('.');
      expect(parts.length).toBeGreaterThanOrEqual(3);

      // Tamper with each part
      for (let i = 0; i < parts.length; i++) {
        const tamperedParts = [...parts];
        const originalPart = tamperedParts[i];
        if (i === 0) {
          tamperedParts[i] = 'v2'; // invalid format
        } else if (i === 1) {
          tamperedParts[i] = '999'; // nonexistent version
        } else {
          // Flip characters in base64url part
          tamperedParts[i] =
            originalPart.length > 2
              ? originalPart.slice(0, -1) + (originalPart.slice(-1) === 'A' ? 'B' : 'A')
              : originalPart + 'X';
        }

        const tamperedCiphertext = tamperedParts.join('.');
        await expect(vault.decrypt(tamperedCiphertext, context)).rejects.toThrow(VaultError);
        await expect(vault.decrypt(tamperedCiphertext, context)).rejects.toThrow('decryption failed');
      }
    });

    it('fails to decrypt truncated or garbage input', async () => {
      const vault = new EnvelopeVault(masterKey32);
      const context = { workspaceId: 'ws-123', provider: 'gemini' as const };

      await expect(vault.decrypt('', context)).rejects.toThrow(VaultError);
      await expect(vault.decrypt('not-valid', context)).rejects.toThrow(VaultError);
      await expect(vault.decrypt('v1.1', context)).rejects.toThrow(VaultError);
    });
  });

  describe('wrong master key', () => {
    it('fails to decrypt with a different master key', async () => {
      const vault1 = new EnvelopeVault(masterKey32);
      const vault2 = new EnvelopeVault(otherMasterKey32);
      const context = { workspaceId: 'ws-1', provider: 'openai' as const };

      const ciphertext = await vault1.encrypt('sensitive-api-token', context);
      await expect(vault2.decrypt(ciphertext, context)).rejects.toThrow(VaultError);
      await expect(vault2.decrypt(ciphertext, context)).rejects.toThrow('decryption failed');
    });
  });

  describe('key rotation support', () => {
    it('decrypts old version ciphertext and uses current version for new encryption', async () => {
      const key1 = randomBytes(32);
      const key2 = randomBytes(32);

      const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
      const context = { workspaceId: 'ws-corp', provider: 'anthropic' as const };
      const ciphertextV1 = await vaultV1.encrypt('my-anthropic-key', context);
      expect(ciphertextV1.startsWith('v1.1.')).toBe(true);

      // Now create multi-key vault with current = 2
      const vaultV2 = new EnvelopeVault({
        current: 2,
        keys: new Map([
          [1, key1],
          [2, key2],
        ]),
      });

      // Old ciphertext can still be decrypted by multi-key vault
      const decryptedOld = await vaultV2.decrypt(ciphertextV1, context);
      expect(decryptedOld).toBe('my-anthropic-key');

      // New ciphertext is encrypted with keyVersion 2
      const ciphertextV2 = await vaultV2.encrypt('my-anthropic-key', context);
      expect(ciphertextV2.startsWith('v1.2.')).toBe(true);

      const decryptedNew = await vaultV2.decrypt(ciphertextV2, context);
      expect(decryptedNew).toBe('my-anthropic-key');
    });
  });
});

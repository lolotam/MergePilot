import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from './service.js';

describe('CredentialService', () => {
  const masterKey = randomBytes(32).toString('base64');

  function createFixture(validateFn?: (provider: string, apiKey: string) => Promise<boolean | void>) {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(masterKey);
    const validate = validateFn ?? vi.fn().mockResolvedValue(true);
    const service = new CredentialService({ store, vault, validate });
    return { store, vault, validate, service };
  }

  describe('saveKey', () => {
    it('trims, validates, encrypts, and stores credential metadata', async () => {
      const { store, service, validate } = createFixture();

      const rawKey = '   sk-ant-api03-abcdef1234567890   ';
      const result = await service.saveKey({
        workspaceId: 'ws-1',
        provider: 'anthropic',
        apiKey: rawKey,
        userId: 'user-42',
      });

      expect(validate).toHaveBeenCalledWith('anthropic', 'sk-ant-api03-abcdef1234567890');
      expect(result.last4).toBe('7890');
      expect(result.keyVersion).toBe(1);
      expect(result.provider).toBe('anthropic');
      expect(result.workspaceId).toBe('ws-1');
      expect(result).not.toHaveProperty('ciphertext');

      const stored = await store.getCredential('ws-1', 'anthropic');
      expect(stored).not.toBeNull();
      expect(stored?.last4).toBe('7890');
      expect(stored?.ciphertext.startsWith('v1.1.')).toBe(true);
      expect(stored?.ciphertext).not.toContain('sk-ant-api03');
    });

    it('rejects empty and whitespace-only keys', async () => {
      const { service } = createFixture();

      await expect(
        service.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: '', userId: 'u1' }),
      ).rejects.toThrow(/empty/i);

      await expect(
        service.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: '   \n  \t ', userId: 'u1' }),
      ).rejects.toThrow(/empty/i);
    });

    it('rejects Claude subscription tokens (sk-ant-oat...) without storing', async () => {
      const { store, service, validate } = createFixture();

      const oatToken = 'sk-ant-oat01-secret-oauth-token-val';
      await expect(
        service.saveKey({
          workspaceId: 'ws-1',
          provider: 'anthropic',
          apiKey: oatToken,
          userId: 'u1',
        }),
      ).rejects.toThrow(/API key/i);

      expect(validate).not.toHaveBeenCalled();
      const stored = await store.getCredential('ws-1', 'anthropic');
      expect(stored).toBeNull();
    });

    it('stores nothing when validate fails or throws', async () => {
      const failingValidate = vi.fn().mockResolvedValue(false);
      const { store, service } = createFixture(failingValidate);

      await expect(
        service.saveKey({
          workspaceId: 'ws-1',
          provider: 'openai',
          apiKey: 'sk-proj-invalid-key-12345',
          userId: 'u1',
        }),
      ).rejects.toThrow();

      const stored = await store.getCredential('ws-1', 'openai');
      expect(stored).toBeNull();

      const throwingValidate = vi.fn().mockRejectedValue(new Error('Connection timeout'));
      const fixture2 = createFixture(throwingValidate);
      await expect(
        fixture2.service.saveKey({
          workspaceId: 'ws-1',
          provider: 'openai',
          apiKey: 'sk-proj-invalid-key-12345',
          userId: 'u1',
        }),
      ).rejects.toThrow('Connection timeout');

      expect(await fixture2.store.getCredential('ws-1', 'openai')).toBeNull();
    });
  });

  describe('listKeys', () => {
    it('never returns plaintext or ciphertext and scopes by workspaceId', async () => {
      const { service } = createFixture();

      await service.saveKey({
        workspaceId: 'ws-A',
        provider: 'anthropic',
        apiKey: 'sk-ant-api03-key-one-1234',
        userId: 'u1',
      });
      await service.saveKey({
        workspaceId: 'ws-A',
        provider: 'openai',
        apiKey: 'sk-proj-key-two-5678',
        userId: 'u1',
      });
      await service.saveKey({
        workspaceId: 'ws-B',
        provider: 'gemini',
        apiKey: 'gemini-key-three-9012',
        userId: 'u2',
      });

      const listA = await service.listKeys('ws-A');
      expect(listA).toHaveLength(2);
      for (const item of listA) {
        expect(item).not.toHaveProperty('ciphertext');
        expect(JSON.stringify(item)).not.toContain('sk-ant');
        expect(JSON.stringify(item)).not.toContain('sk-proj');
        expect(JSON.stringify(item)).not.toContain('v1.');
      }

      const listB = await service.listKeys('ws-B');
      expect(listB).toHaveLength(1);
      expect(listB[0].provider).toBe('gemini');
      expect(listB[0].last4).toBe('9012');
      expect(listB[0]).not.toHaveProperty('ciphertext');
    });
  });

  describe('deleteKey', () => {
    it('deletes the credential for the given workspace and provider', async () => {
      const { store, service } = createFixture();

      await service.saveKey({
        workspaceId: 'ws-1',
        provider: 'openai',
        apiKey: 'sk-openai-key-test-9999',
        userId: 'u1',
      });
      expect(await store.getCredential('ws-1', 'openai')).not.toBeNull();

      await service.deleteKey('ws-1', 'openai');
      expect(await store.getCredential('ws-1', 'openai')).toBeNull();
    });
  });

  describe('resolve', () => {
    it('resolves to Secret, which never leaks in JSON or inspect', async () => {
      const { service } = createFixture();
      const rawSecret = 'sk-ant-api03-super-secret-key-4321';

      await service.saveKey({
        workspaceId: 'ws-alpha',
        provider: 'anthropic',
        apiKey: rawSecret,
        userId: 'u1',
      });

      const secret = await service.resolve('ws-alpha', 'anthropic');
      expect(secret).toBeInstanceOf(Secret);

      // Secret protections
      expect(secret.toString()).toBe('[REDACTED]');
      expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
      expect(JSON.stringify({ key: secret })).toBe('{"key":"[REDACTED]"}');
      expect(inspect(secret)).toBe('[REDACTED]');

      // Raw value only revealed via reveal()
      expect(secret.reveal()).toBe(rawSecret);
    });

    it('enforces workspace isolation: workspace B cannot resolve workspace A key', async () => {
      const { service } = createFixture();

      await service.saveKey({
        workspaceId: 'ws-A',
        provider: 'openai',
        apiKey: 'sk-openai-belonging-to-A-1111',
        userId: 'uA',
      });

      await expect(service.resolve('ws-B', 'openai')).rejects.toThrow();
    });
  });
});

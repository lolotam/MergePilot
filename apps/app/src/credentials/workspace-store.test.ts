import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MissingCredentialError, Secret } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { WorkspaceCredentialStore } from './workspace-store.js';

describe('WorkspaceCredentialStore', () => {
  const masterKey = randomBytes(32).toString('base64');

  async function createFixture() {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(masterKey);
    const workspaceStoreA = new WorkspaceCredentialStore({ workspaceId: 'ws-A', store, vault });
    const workspaceStoreB = new WorkspaceCredentialStore({ workspaceId: 'ws-B', store, vault });
    return { store, vault, workspaceStoreA, workspaceStoreB };
  }

  describe('info()', () => {
    it('returns configured: false when no credential exists', async () => {
      const { workspaceStoreA } = await createFixture();
      const info = await workspaceStoreA.info({ provider: 'anthropic' });
      expect(info.configured).toBe(false);
      expect(info.provider).toBe('anthropic');
      expect(info.source).toBe('none');
      expect(info.envName).toBe('ANTHROPIC_API_KEY');
    });

    it('returns configured: true when credential exists in the workspace', async () => {
      const { store, vault, workspaceStoreA } = await createFixture();
      const ciphertext = await vault.encrypt('sk-ant-api03-test-val', {
        workspaceId: 'ws-A',
        provider: 'anthropic',
      });
      await store.saveCredential({
        id: 'c1',
        workspaceId: 'ws-A',
        provider: 'anthropic',
        ciphertext,
        keyVersion: 1,
        last4: '-val',
        createdBy: 'u1',
        createdAt: new Date(),
      });

      const info = await workspaceStoreA.info({ provider: 'anthropic' });
      expect(info.configured).toBe(true);
      expect(info.provider).toBe('anthropic');
      expect(info.source).toBe('env');
    });

    it('returns configured: false for claude-code', async () => {
      const { workspaceStoreA } = await createFixture();
      const info = await workspaceStoreA.info({ provider: 'claude-code' });
      expect(info.configured).toBe(false);
      expect(info.provider).toBe('claude-code');
      expect(info.source).toBe('none');
    });
  });

  describe('resolve()', () => {
    it('resolves configured credential to Secret', async () => {
      const { store, vault, workspaceStoreA } = await createFixture();
      const rawSecret = 'sk-proj-super-secret-openai-key-9999';
      const ciphertext = await vault.encrypt(rawSecret, { workspaceId: 'ws-A', provider: 'openai' });
      await store.saveCredential({
        id: 'c2',
        workspaceId: 'ws-A',
        provider: 'openai',
        ciphertext,
        keyVersion: 1,
        last4: '9999',
        createdBy: 'u1',
        createdAt: new Date(),
      });

      const secret = await workspaceStoreA.resolve({ provider: 'openai' }, 'review');
      expect(secret).toBeInstanceOf(Secret);
      expect(secret.reveal()).toBe(rawSecret);
    });

    it('throws MissingCredentialError when provider is not configured', async () => {
      const { workspaceStoreA } = await createFixture();
      await expect(workspaceStoreA.resolve({ provider: 'gemini' }, 'review')).rejects.toThrow(
        MissingCredentialError,
      );
    });

    it('throws a clear "not available in the SaaS" error for claude-code', async () => {
      const { workspaceStoreA } = await createFixture();
      await expect(workspaceStoreA.resolve({ provider: 'claude-code' }, 'review')).rejects.toThrow(
        /not available in the SaaS/i,
      );
    });

    it('enforces workspace isolation: workspace B cannot resolve workspace A keys', async () => {
      const { store, vault, workspaceStoreA, workspaceStoreB } = await createFixture();
      const ciphertext = await vault.encrypt('secret-for-A', { workspaceId: 'ws-A', provider: 'openai' });
      await store.saveCredential({
        id: 'c3',
        workspaceId: 'ws-A',
        provider: 'openai',
        ciphertext,
        keyVersion: 1,
        last4: 'or-A',
        createdBy: 'u1',
        createdAt: new Date(),
      });

      // A can resolve it
      const secretA = await workspaceStoreA.resolve({ provider: 'openai' }, 'review');
      expect(secretA.reveal()).toBe('secret-for-A');

      // B cannot resolve it
      await expect(workspaceStoreB.resolve({ provider: 'openai' }, 'review')).rejects.toThrow(
        MissingCredentialError,
      );
    });
  });
});

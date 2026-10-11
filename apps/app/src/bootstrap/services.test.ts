import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../core/config.js';
import { MemoryStore } from '../core/memory-store.js';
import { buildServices } from './services.js';

describe('bootstrap/services', { timeout: 20000 }, () => {
  const masterKey1 = randomBytes(32).toString('base64');
  const masterKey2 = randomBytes(32).toString('base64');

  const baseConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'memory:',
    masterKey: masterKey1,
    github: {
      appId: '12345',
      privateKey: 'fake-private-key',
      webhookSecret: 'fake-webhook-secret',
      clientId: 'fake-gh-client-id',
      clientSecret: 'fake-gh-client-secret',
      appSlug: 'test-mergepilot',
    },
    google: { clientId: 'fake-google-id', clientSecret: 'fake-google-secret' },
    authSecret: 'better-auth-secret-1234567890',
  };

  it('builds services with memory URLs for local dev and testing', async () => {
    const services = await buildServices(baseConfig);
    try {
      expect(services.store).toBeInstanceOf(MemoryStore);
      expect(services.vault).toBeDefined();
      expect(services.vault.keyVersion).toBe(1);
      expect(services.credentials).toBeDefined();
      expect(services.auth).toBeDefined();
      expect(services.queue).toBeDefined();
      expect(services.db).toBeDefined();
    } finally {
      await services.close();
    }
  });

  it('supports key rotation with MERGEPILOT_MASTER_KEY_PREVIOUS and MERGEPILOT_MASTER_KEY_VERSION', async () => {
    // 1. Create a service with key v1 and encrypt a secret
    const v1Services = await buildServices(baseConfig);
    let ciphertext: string;
    try {
      ciphertext = await v1Services.vault.encrypt('my-secret-key-1234', {
        workspaceId: 'ws-test',
        provider: 'anthropic',
      });
      expect(ciphertext.startsWith('v1.1.')).toBe(true);
    } finally {
      await v1Services.close();
    }

    // 2. Rotate to key v2, keeping v1 as previous
    const rotatedConfig: AppConfig = {
      ...baseConfig,
      masterKey: masterKey2,
    };
    const env = {
      MERGEPILOT_MASTER_KEY_PREVIOUS: masterKey1,
      MERGEPILOT_MASTER_KEY_VERSION: '2',
    };

    const v2Services = await buildServices(rotatedConfig, { env });
    try {
      expect(v2Services.vault.keyVersion).toBe(2);

      // Should be able to decrypt old ciphertext created with v1
      const decryptedOld = await v2Services.vault.decrypt(ciphertext, {
        workspaceId: 'ws-test',
        provider: 'anthropic',
      });
      expect(decryptedOld).toBe('my-secret-key-1234');

      // New ciphertext is encrypted with v2
      const newCiphertext = await v2Services.vault.encrypt('my-new-secret', {
        workspaceId: 'ws-test',
        provider: 'openai',
      });
      expect(newCiphertext.startsWith('v1.2.')).toBe(true);

      const decryptedNew = await v2Services.vault.decrypt(newCiphertext, {
        workspaceId: 'ws-test',
        provider: 'openai',
      });
      expect(decryptedNew).toBe('my-new-secret');
    } finally {
      await v2Services.close();
    }
  });

  it('close cleans up database and queue connections', async () => {
    const services = await buildServices(baseConfig);
    await expect(services.close()).resolves.toBeUndefined();
  });
});

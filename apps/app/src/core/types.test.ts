import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './config.js';
import { MemoryStore } from './memory-store.js';
import { roleAtLeast } from './types.js';

describe('roleAtLeast', () => {
  it('orders member < admin < owner', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
  });
});

describe('loadAppConfig', () => {
  it('lists every missing variable by name without values', () => {
    expect(() => loadAppConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/MERGEPILOT_MASTER_KEY/);
  });
});

describe('MemoryStore', () => {
  it('rejects a duplicate delivery and scopes credentials by workspace', async () => {
    const store = new MemoryStore();
    expect(await store.recordDelivery('d1', 'pull_request')).toBe(true);
    expect(await store.recordDelivery('d1', 'pull_request')).toBe(false);
    await store.saveCredential({
      id: 'c1', workspaceId: 'w1', provider: 'openai', ciphertext: 'x', keyVersion: 1,
      last4: '1234', createdBy: 'u1', createdAt: new Date(),
    });
    expect(await store.getCredential('w2', 'openai')).toBeNull();
    expect((await store.listCredentials('w1'))[0]).not.toHaveProperty('ciphertext');
  });
});

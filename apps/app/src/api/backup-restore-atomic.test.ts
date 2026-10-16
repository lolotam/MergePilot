import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from '../credentials/service.js';
import type { WorkspaceRestore } from '../core/types.js';
import {
  createBackupHarness,
  exportBackup,
  fakeKey,
  PASSPHRASE,
  restoreBackup,
  seedWorkspace,
  type BackupHarness,
} from './backup-routes.fixtures.js';

const subCredential = (): SubscriptionCredential => ({
  type: 'oauth',
  access: ['test', 'access', '1111'].join('-'),
  refresh: ['test', 'refresh'].join('-'),
  expires: Date.now() + 3_600_000,
});

describe('settings restore atomicity and overlay (ADR-0018 / ADR-0027)', { timeout: 60000 }, () => {
  describe('memory store', () => {
    it('rolls back when a dual-provider restore change fails', async () => {
      const store = new MemoryStore();
      const vault = new EnvelopeVault(Buffer.alloc(32, 8).toString('base64'));
      const service = new CredentialService({ store, vault });
      await service.saveKey({ workspaceId: 'ws', provider: 'typesafe', apiKey: fakeKey('typesafe'), userId: 'u' });
      const before = {
        settings: await store.getSettings('ws'),
        credentials: await store.listCredentials('ws'),
      };
      const restore: WorkspaceRestore = {
        dualProviderKeyChanges: [
          {
            provider: 'openai',
            change: async () => {
              throw new Error('dual restore failed');
            },
          },
        ],
      };
      await expect(store.restoreWorkspace('ws', restore)).rejects.toThrow('dual restore failed');
      expect(await store.getSettings('ws')).toEqual(before.settings);
      expect(await store.listCredentials('ws')).toEqual(before.credentials);
    });
  });

  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
  }, 60000);

  afterEach(async () => {
    await h.close();
  });

  it('postgres restore leaves prior state when a dual-provider change fails', async () => {
    await seedWorkspace(h);
    const settingsBefore = await h.store.getSettings('ws-1');
    const credsBefore = await h.store.listCredentials('ws-1');
    await expect(
      h.store.restoreWorkspace('ws-1', {
        dualProviderKeyChanges: [
          {
            provider: 'openai',
            change: async () => {
              throw new Error('dual restore failed');
            },
          },
        ],
      }),
    ).rejects.toThrow('dual restore failed');
    expect(await h.store.getSettings('ws-1')).toEqual(settingsBefore);
    expect(await h.store.listCredentials('ws-1')).toEqual(credsBefore);
  });

  it('accepts heavy and fallback providers restored from the same dual-method backup on a fresh workspace', async () => {
    await h.credentials.saveSubscription('ws-1', 'openai', subCredential(), 'u-owner');
    await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'openai',
      apiKey: fakeKey('openai-heavy'),
      userId: 'u-owner',
    });
    const exported = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const file = {
      ...exported,
      settings: {
        ...(exported.settings as Record<string, unknown>),
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        language: 'ar',
        heavyProvider: 'openai',
        heavyModel: 'gpt-5',
        fallback: [{ provider: 'openai', model: 'gpt-5-mini' }],
      },
    };
    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(await h.store.getCredential('ws-2', 'openai')).not.toBeNull();
  });
});

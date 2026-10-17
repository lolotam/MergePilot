import { describe, expect, it } from 'vitest';
import { Secret } from '@mergepilot/engine';
import type { AppStore } from '../core/types.js';
import type { CredentialService } from '../credentials/service.js';
import { BackupChangedError, buildBackupFile } from './backup-export.js';

describe('buildBackupFile', () => {
  it('seals a custom key with the URL read together with it, not an older listing', async () => {
    const fake = ['fake', 'custom', 'key', '0001'].join('-');
    const store = {
      getSettings: async () => null,
      listReviewerBots: async () => [],
      listReviewSkills: async () => [],
    } as unknown as AppStore;
    // The listing still shows the old URL; the credential was rotated to a new URL meanwhile.
    const credentials = {
      listKeys: async () => [{ provider: 'custom', baseUrl: 'https://old.example.com/v1', last4: '0001' }],
      resolveCredential: async () => ({ secret: new Secret(fake), baseUrl: 'https://new.example.com/v1' }),
    } as unknown as CredentialService;

    const { file } = await buildBackupFile(
      { store, credentials },
      { id: 'ws-1', name: 'One', slug: 'one' },
      { includeKeys: true, passphrase: 'a long test passphrase', now: new Date('2026-10-13T00:00:00Z') },
    );
    expect(file.credentials).toHaveLength(1);
    expect(file.credentials[0]?.baseUrl).toBe('https://new.example.com/v1');
    expect(JSON.stringify(file)).not.toContain(fake);
  });

  it('refuses an export when a listed skill is deleted before its content is read (ADR-0034)', async () => {
    const skillId = '00000000-0000-4000-8000-000000000001';
    const store = {
      getSettings: async () => ({ workspaceId: 'ws-1', provider: 'openai', model: 'm', language: 'en', monthlyBudgetUsd: null, skillId }),
      listReviewerBots: async () => [],
      listReviewSkills: async () => [{ id: skillId, name: 'Security' }],
      getReviewSkill: async () => null,
    } as unknown as AppStore;
    const credentials = { listKeys: async () => [] } as unknown as CredentialService;

    await expect(
      buildBackupFile({ store, credentials }, { id: 'ws-1', name: 'One', slug: 'one' }, { includeKeys: false, now: new Date() }),
    ).rejects.toBeInstanceOf(BackupChangedError);
  });
});

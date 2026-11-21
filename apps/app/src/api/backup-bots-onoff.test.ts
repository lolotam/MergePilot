import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackupHarness,
  exportBackup,
  PASSPHRASE,
  restoreBackup,
  seedWorkspace,
  type BackupHarness,
} from './backup-routes.fixtures.js';

type BackupFileJson = Record<string, unknown> & {
  settings: Record<string, unknown> | null;
  bots: Array<Record<string, unknown>>;
};

describe('bot on/off switches in settings backup (migration 0021)', { timeout: 120000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
    await seedWorkspace(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/settings',
      headers: { cookie: h.cookie('owner') },
      payload: { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en', mainBotActive: false, botsEnabled: false },
    });
    expect(res.statusCode).toBe(200);
  }, 120000);

  afterEach(async () => {
    await h.close();
  });

  const exported = async (): Promise<BackupFileJson> => {
    const res = await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);
    return res.json() as BackupFileJson;
  };
  const settingsOf = (ws: string) => h.store.getSettings(ws);
  const mainActiveOf = async (ws: string) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/bots`, headers: { cookie: h.cookie('owner') } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { main: { active: boolean } }).main.active;
  };

  it('exports both switches and restores them into another owned workspace', async () => {
    const file = await exported();
    expect(file.settings).toMatchObject({ mainBotActive: false, botsEnabled: false });

    const preview = await restoreBackup(h, { file, passphrase: PASSPHRASE, dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().settingsChanged).toContain('mainBotActive');
    expect(preview.json().settingsChanged).toContain('botsEnabled');

    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect(await settingsOf('ws-2')).toMatchObject({ mainBotActive: false, botsEnabled: false });
    expect(await mainActiveOf('ws-2')).toBe(false);
  });

  it('restores an old file without either switch and keeps the target\'s saved switches', async () => {
    const file = await exported();
    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect(await settingsOf('ws-2')).toMatchObject({ mainBotActive: false, botsEnabled: false });

    const old = structuredClone(file);
    if (old.settings) {
      delete old.settings.mainBotActive;
      delete old.settings.botsEnabled;
    }
    expect((await restoreBackup(h, { file: old, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect(await settingsOf('ws-2')).toMatchObject({ mainBotActive: false, botsEnabled: false });
    expect(await mainActiveOf('ws-2')).toBe(false);
  });

  it('refuses invalid switch data before any write, leaving the target untouched', async () => {
    const file = await exported();
    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    const before = await settingsOf('ws-2');

    for (const key of ['mainBotActive', 'botsEnabled'] as const) {
      const bad = structuredClone(file);
      if (bad.settings) bad.settings[key] = 'off';
      const res = await restoreBackup(h, { file: bad, passphrase: PASSPHRASE });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'validation_error', field: `settings.${key}` });
    }
    expect(await settingsOf('ws-2')).toEqual(before);
  });
});

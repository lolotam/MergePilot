import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackupHarness,
  exportBackup,
  PASSPHRASE,
  restoreBackup,
  seedWorkspace,
  type BackupHarness,
} from './backup-routes.fixtures.js';

const MAIN_TIMEOUT = 600000;
const OWL_TIMEOUT = 900000;
const FOX_TIMEOUT = 300000;

type BackupFileJson = Record<string, unknown> & {
  settings: Record<string, unknown> | null;
  bots: Array<Record<string, unknown>>;
};

describe('per-bot call timeout in settings backup (ADR-0018)', { timeout: 120000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
    await seedWorkspace(h);
    const put = async (url: string, payload: Record<string, unknown>) => {
      const res = await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie('owner') }, payload });
      expect(res.statusCode).toBe(200);
    };
    // The seeded main settings and the two extra bots, each with its own override.
    await put('/api/workspaces/ws-1/settings', {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      language: 'ar',
      callTimeoutMs: MAIN_TIMEOUT,
    });
    await put('/api/workspaces/ws-1/bots/2', {
      name: 'Owl',
      logo: 'owl',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      fallback: [],
      callTimeoutMs: OWL_TIMEOUT,
    });
    await put('/api/workspaces/ws-1/bots/4', {
      name: 'Fox',
      logo: 'fox',
      active: false,
      provider: 'anthropic',
      model: 'claude-haiku-5',
      effort: 'low',
      fallback: [{ provider: 'openrouter', model: 'openai/gpt-5-mini' }],
      callTimeoutMs: FOX_TIMEOUT,
    });
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
  const botTimeouts = async (ws: string) => (await h.store.listReviewerBots(ws)).map((bot) => [bot.slot, bot.callTimeoutMs]);

  it('exports the main and the extra bots\' overrides', async () => {
    const file = await exported();
    expect(file.settings?.callTimeoutMs).toBe(MAIN_TIMEOUT);
    expect(file.bots.map((bot) => [bot.slot, bot.callTimeoutMs])).toEqual([
      [2, OWL_TIMEOUT],
      [4, FOX_TIMEOUT],
    ]);
  });

  it('round trip restores the main and extra overrides into another owned workspace', async () => {
    const file = await exported();
    const preview = await restoreBackup(h, { file, passphrase: PASSPHRASE, dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().settingsChanged).toContain('callTimeoutMs');

    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect((await settingsOf('ws-2'))?.callTimeoutMs).toBe(MAIN_TIMEOUT);
    expect(await botTimeouts('ws-2')).toEqual([
      [2, OWL_TIMEOUT],
      [4, FOX_TIMEOUT],
    ]);
    // Read back through the API: this is what the dashboard shows after the restore.
    const bots = (await h.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-2/bots',
      headers: { cookie: h.cookie('owner') },
    })).json();
    expect(bots.main.callTimeoutMs).toBe(MAIN_TIMEOUT);
  });

  it('restores an old file without the field to inheritance over a pre-existing override', async () => {
    const file = await exported();
    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect((await settingsOf('ws-2'))?.callTimeoutMs).toBe(MAIN_TIMEOUT);

    const old = structuredClone(file);
    if (old.settings) delete old.settings.callTimeoutMs;
    for (const bot of old.bots) delete bot.callTimeoutMs;
    expect((await restoreBackup(h, { file: old, passphrase: PASSPHRASE })).statusCode).toBe(200);
    expect((await settingsOf('ws-2'))?.callTimeoutMs).toBeNull();
    expect(await botTimeouts('ws-2')).toEqual([
      [2, null],
      [4, null],
    ]);
  });

  it('refuses invalid timeout data before any write, leaving the target untouched', async () => {
    const file = await exported();
    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE })).statusCode).toBe(200);
    const settingsBefore = await settingsOf('ws-2');
    const botsBefore = await h.store.listReviewerBots('ws-2');

    const badMain = structuredClone(file);
    if (badMain.settings) badMain.settings.callTimeoutMs = 500;
    const main = await restoreBackup(h, { file: badMain, passphrase: PASSPHRASE });
    expect(main.statusCode).toBe(400);
    expect(main.json().error).toMatchObject({ code: 'validation_error', field: 'settings.callTimeoutMs' });

    const badBot = structuredClone(file);
    badBot.bots[0] = { ...(badBot.bots[0] ?? {}), callTimeoutMs: '600000' };
    const bot = await restoreBackup(h, { file: badBot, passphrase: PASSPHRASE });
    expect(bot.statusCode).toBe(400);
    expect(bot.json().error).toMatchObject({ code: 'validation_error', field: 'bots[0].callTimeoutMs' });

    // A file that would change the settings is refused as a whole when a bot is invalid.
    const mixed = structuredClone(file);
    if (mixed.settings) mixed.settings.callTimeoutMs = 1000;
    mixed.bots[1] = { ...(mixed.bots[1] ?? {}), callTimeoutMs: 1.5 };
    const res = await restoreBackup(h, { file: mixed, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.field).toBe('bots[1].callTimeoutMs');

    expect(await settingsOf('ws-2')).toEqual(settingsBefore);
    expect(await h.store.listReviewerBots('ws-2')).toEqual(botsBefore);
  });

  it('leaves the target settings untouched when the file has no settings section', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-2/settings',
      headers: { cookie: h.cookie('owner') },
      payload: { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en', callTimeoutMs: 1000, botName: 'Target Pilot' },
    });
    expect(put.statusCode).toBe(200);
    const before = await settingsOf('ws-2');

    const file = await exported();
    const withoutSettings = { ...structuredClone(file), settings: null };
    const res = await restoreBackup(h, { file: withoutSettings, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);
    expect(res.json().settingsChanged).toEqual([]);
    expect(await settingsOf('ws-2')).toEqual(before);
    expect((await settingsOf('ws-2'))?.callTimeoutMs).toBe(1000);
    // The bots section still restores, with the overrides the file carries.
    expect(await botTimeouts('ws-2')).toEqual([
      [2, OWL_TIMEOUT],
      [4, FOX_TIMEOUT],
    ]);
  });
});

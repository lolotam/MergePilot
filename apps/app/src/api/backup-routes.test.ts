import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBackupHarness,
  exportBackup,
  fakeKey,
  PASSPHRASE,
  restoreBackup,
  seedWorkspace,
  type BackupHarness,
} from './backup-routes.fixtures.js';

const SEEDED = ['anthropic', 'openrouter', 'typesafe', 'custom'] as const;

describe('settings backup: export and restore (ADR-0018)', { timeout: 60000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
    await seedWorkspace(h);
  }, 60000);

  afterEach(async () => {
    await h.close();
  });

  const get = async (path: string, ws: string) =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/${path}`, headers: { cookie: h.cookie('owner') } })).json();
  const exported = async (body: Record<string, unknown> = { includeKeys: true, passphrase: PASSPHRASE }) => {
    const res = await exportBackup(h, body);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const plainKeys = async (ws: string) =>
    Object.fromEntries(
      await Promise.all(SEEDED.map(async (p) => [p, (await h.credentials.resolve(ws, p).catch(() => null))?.reveal() ?? null])),
    );

  it('exports the settings, bots and passphrase-sealed keys as an attachment, never a plaintext key', async () => {
    const res = await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="mergepilot-settings-team-one-20261013.json"');
    for (const provider of SEEDED) expect(res.body).not.toContain(fakeKey(provider));
    expect(res.body).not.toContain(PASSPHRASE);

    const file = res.json();
    expect(file).toMatchObject({
      format: 'mergepilot-settings',
      version: 1,
      exportedAt: '2026-10-13T08:00:00.000Z',
      app: { version: expect.any(String) },
      workspace: { name: 'Team One' },
    });
    expect(file.settings).not.toHaveProperty('workspaceId');
    expect(file.bots.map((b: { slot: number; name: string }) => [b.slot, b.name])).toEqual([[2, 'Owl'], [4, 'Fox']]);
    const custom = file.credentials.find((c: { provider: string }) => c.provider === 'custom');
    expect(custom).toMatchObject({ baseUrl: 'https://llm.example.com/v1', last4: fakeKey('custom').slice(-4) });
    expect(custom.key).toMatchObject({ alg: 'aes-256-gcm', kdf: 'scrypt' });
    expect(file.credentials.find((c: { provider: string }) => c.provider === 'anthropic')).not.toHaveProperty('baseUrl');
    // One random salt per file, a fresh iv per key.
    const salts = new Set(file.credentials.map((c: { key: { salt: string } }) => c.key.salt));
    const ivs = new Set(file.credentials.map((c: { key: { iv: string } }) => c.key.iv));
    expect([salts.size, ivs.size]).toEqual([1, SEEDED.length]);
  });

  it('exports every key of the GET /settings DTO, so new settings fields are backed up without changes', async () => {
    const { settings } = await get('settings', 'ws-1');
    const file = await exported({ includeKeys: false });
    const { workspaceId: _ws, ...dto } = settings;
    expect(Object.keys(file.settings).sort()).toEqual(Object.keys(dto).sort());
    expect(file.settings).toEqual(dto);
  });

  it('round trip: restores settings, bots and keys into another owned workspace exactly', async () => {
    const file = await exported();
    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      dryRun: false,
      sections: ['settings', 'bots', 'credentials'],
      bots: 2,
      keysTested: false,
      credentials: [...SEEDED]
        .sort((a, b) => a.localeCompare(b))
        .map((provider) => ({ provider, last4: fakeKey(provider).slice(-4), action: 'add' })),
    });

    expect(await get('settings', 'ws-2')).toEqual({ settings: { ...(await get('settings', 'ws-1')).settings, workspaceId: 'ws-2' } });
    expect((await get('settings', 'ws-2')).settings.maxFindings).toBe(25);
    expect((await get('bots', 'ws-2')).bots).toEqual((await get('bots', 'ws-1')).bots);
    // The decrypted keys equal the originals (checked server-side, through the vault).
    expect(await plainKeys('ws-2')).toEqual(Object.fromEntries(SEEDED.map((p) => [p, fakeKey(p)])));
    expect((await h.store.getCredential('ws-2', 'custom'))?.baseUrl).toBe('https://llm.example.com/v1');
    expect((await h.store.getCredential('ws-2', 'anthropic'))?.createdBy).toBe('u-owner');
  });

  it('full backup of the same workspace undoes a mistake; keys are replaced', async () => {
    const file = await exported();
    await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/settings',
      headers: { cookie: h.cookie('owner') },
      payload: { provider: 'anthropic', model: 'claude-opus-5', language: 'en', fallback: null, heavyProvider: null, heavyModel: null },
    });
    await h.app.inject({ method: 'DELETE', url: '/api/workspaces/ws-1/bots/2', headers: { cookie: h.cookie('owner') } });
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: fakeKey('wrong'), userId: 'u-admin' });

    const preview = await restoreBackup(h, { file, passphrase: PASSPHRASE, dryRun: true }, 'owner', 'ws-1');
    expect(preview.json()).toMatchObject({ dryRun: true, bots: 2 });
    expect(preview.json().settingsChanged).toEqual(expect.arrayContaining(['model', 'language', 'fallback', 'heavyProvider', 'heavyModel']));
    expect(preview.json().credentials.every((c: { action: string }) => c.action === 'replace')).toBe(true);

    expect((await restoreBackup(h, { file, passphrase: PASSPHRASE }, 'owner', 'ws-1')).statusCode).toBe(200);
    expect((await get('settings', 'ws-1')).settings).toMatchObject({ model: 'claude-sonnet-5-5', language: 'ar', heavyModel: 'openai/gpt-5' });
    expect((await get('bots', 'ws-1')).bots).toHaveLength(2);
    expect(await plainKeys('ws-1')).toEqual(Object.fromEntries(SEEDED.map((p) => [p, fakeKey(p)])));
  });

  it('a dry run previews the change and writes nothing', async () => {
    const file = await exported();
    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE, dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, bots: 2, keysTested: false });
    expect(res.json().settingsChanged).toEqual(expect.arrayContaining(['provider', 'model', 'maxFindings', 'judge', 'botName', 'panelMode']));
    expect((await get('settings', 'ws-2')).settings).toBeNull();
    expect((await get('bots', 'ws-2')).bots).toEqual([]);
    expect(await h.store.listCredentials('ws-2')).toEqual([]);
  });

  it('partial restore: only the keys, or only the settings and bots', async () => {
    const file = await exported();
    const keysOnly = await restoreBackup(h, { file, passphrase: PASSPHRASE, sections: ['credentials'] });
    expect(keysOnly.json()).toMatchObject({ sections: ['credentials'], settingsChanged: [], bots: 0 });
    expect((await get('settings', 'ws-2')).settings).toBeNull();
    expect((await get('bots', 'ws-2')).bots).toEqual([]);
    expect(await plainKeys('ws-2')).toEqual(Object.fromEntries(SEEDED.map((p) => [p, fakeKey(p)])));

    // The settings and bots need the restored keys (fallback, heavy, judge) — now stored.
    const rest = await restoreBackup(h, { file, sections: ['settings', 'bots'] });
    expect(rest.statusCode).toBe(200);
    expect((await get('settings', 'ws-2')).settings.botName).toBe('Pilot Prime');
    expect((await get('bots', 'ws-2')).bots).toHaveLength(2);
  });

  it('a file without keys restores settings and bots and leaves the stored keys alone', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-2', provider: 'anthropic', apiKey: fakeKey('ws2-own'), userId: 'u-owner' });
    for (const p of ['openrouter', 'typesafe'] as const) {
      await h.credentials.saveKey({ workspaceId: 'ws-2', provider: p, apiKey: fakeKey(`ws2-${p}`), userId: 'u-owner' });
    }
    await h.credentials.saveKey({ workspaceId: 'ws-2', provider: 'custom', apiKey: fakeKey('ws2-c'), userId: 'u-owner', baseUrl: 'https://other.example.com' });
    const file = await exported({ includeKeys: false });
    expect(file.credentials.every((c: Record<string, unknown>) => !('key' in c))).toBe(true);

    const res = await restoreBackup(h, { file });
    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toEqual([]);
    expect((await h.credentials.resolve('ws-2', 'anthropic')).reveal()).toBe(fakeKey('ws2-own'));
    expect((await h.store.getCredential('ws-2', 'custom'))?.baseUrl).toBe('https://other.example.com');
    expect((await get('settings', 'ws-2')).settings.model).toBe('claude-sonnet-5-5');
  });

  it('only owners may export or restore; the target is the URL workspace, never the file', async () => {
    const file = await exported();
    for (const who of ['admin', 'member'] as const) {
      expect((await exportBackup(h, { includeKeys: false }, who)).statusCode).toBe(403);
      expect((await restoreBackup(h, { file, passphrase: PASSPHRASE }, who, 'ws-1')).statusCode).toBe(403);
    }
    // ws-3 belongs to another owner: a file naming it changes nothing there.
    const aimed = { ...file, workspace: { name: 'Someone else', id: 'ws-3' }, workspaceId: 'ws-3' };
    expect((await restoreBackup(h, { file: aimed, passphrase: PASSPHRASE }, 'owner', 'ws-3')).statusCode).toBe(403);
    expect((await restoreBackup(h, { file: aimed, passphrase: PASSPHRASE }, 'owner', 'ws-2')).statusCode).toBe(200);
    expect(await h.store.getSettings('ws-3')).toBeNull();
    expect(await h.store.listCredentials('ws-3')).toEqual([]);
  });

  it('never logs the passphrase or a key, and logs the export and restore with counts', async () => {
    const file = await exported();
    await restoreBackup(h, { file, passphrase: PASSPHRASE });
    await restoreBackup(h, { file, passphrase: `${PASSPHRASE}-wrong` });
    const text = h.logText();
    expect(text).not.toContain(PASSPHRASE);
    for (const provider of SEEDED) expect(text).not.toContain(fakeKey(provider));

    const events = h.logLines().filter((l) => typeof l.event === 'string' && String(l.event).startsWith('backup.'));
    expect(events).toEqual([
      expect.objectContaining({ event: 'backup.export', workspaceId: 'ws-1', includeKeys: true, settings: true, bots: 2, credentials: 4, keys: 4 }),
      expect.objectContaining({ event: 'backup.restore', workspaceId: 'ws-2', bots: 2, credentials: 4 }),
    ]);
  });
});

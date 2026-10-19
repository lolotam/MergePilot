import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsChangedError } from '../core/types.js';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

describe('PUT /settings optimistic concurrency', () => {
  let h: ProviderHarness;
  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (patch: Record<string, unknown>) => h.app.inject({
    method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
    payload: { ...base, ...patch },
  });
  const get = () => h.app.inject({
    method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
  });
  const conflict = { error: {
    code: 'settings_conflict', message: 'Settings changed while saving; reload and try again',
  } };

  beforeEach(async () => {
    h = await createProviderHarness();
    expect((await put({ monthlyBudgetUsd: 50 })).statusCode).toBe(200);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('rejects a stale full form loaded before another tab saved, without writing', async () => {
    const loaded = (await get()).json();
    expect(loaded.settingsVersion).toMatch(/^[a-f0-9]{64}$/);
    expect((await put({ monthlyBudgetUsd: 75, expectedVersion: loaded.settingsVersion })).statusCode).toBe(200);
    const current = await h.store.getSettings('ws-1');
    const save = vi.spyOn(h.store, 'saveSettings');

    const res = await put({ ...loaded.settings, maxFindings: 20, expectedVersion: loaded.settingsVersion });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(save).not.toHaveBeenCalled();
    expect(await h.store.getSettings('ws-1')).toEqual(current);
  });

  it('returns the stored version after a matching save and keeps it stable for unchanged settings', async () => {
    const loaded = (await get()).json();
    expect(loaded.settingsVersion).toMatch(/^[a-f0-9]{64}$/);
    const changed = await put({ maxFindings: 20, expectedVersion: loaded.settingsVersion });
    expect(changed.statusCode).toBe(200);
    const saved = changed.json();
    expect(saved.settingsVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.settingsVersion).not.toBe(loaded.settingsVersion);
    expect((await get()).json().settingsVersion).toBe(saved.settingsVersion);

    const unchanged = await put({ maxFindings: 20, expectedVersion: saved.settingsVersion });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().settingsVersion).toBe(saved.settingsVersion);
  });

  it.each([false, true])('makes one save attempt on a store race (version supplied: %s)', async (versioned) => {
    const loaded = (await get()).json();
    const previous = await h.store.getSettings('ws-1');
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...previous!, monthlyBudgetUsd: 75 });
      throw new SettingsChangedError('ws-1');
    });

    const res = await put({ maxFindings: 20, ...(versioned ? { expectedVersion: loaded.settingsVersion } : {}) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual({ expected: previous });
    expect(await h.store.getSettings('ws-1')).toEqual({ ...previous, monthlyBudgetUsd: 75 });
  });

  it('never passes expectedVersion to the store or echoes it inside settings', async () => {
    const loaded = (await get()).json();
    expect(loaded.settingsVersion).toMatch(/^[a-f0-9]{64}$/);
    const save = vi.spyOn(h.store, 'saveSettings');
    const res = await put({ expectedVersion: loaded.settingsVersion, maxFindings: 20 });
    expect(res.statusCode).toBe(200);
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('expectedVersion');
    expect(await h.store.getSettings('ws-1')).not.toHaveProperty('expectedVersion');
    expect(res.json().settings).not.toHaveProperty('expectedVersion');
    expect(res.json().settings).not.toHaveProperty('settingsVersion');
    expect((await get()).json().settings).not.toHaveProperty('expectedVersion');
  });

  it('versions a missing settings row and accepts that version when creating settings', async () => {
    await h.addWorkspace('ws-empty');
    const read = () => h.app.inject({
      method: 'GET', url: '/api/workspaces/ws-empty/settings', headers: { cookie: h.adminCookie() },
    });
    const empty = (await read()).json();
    expect(empty.settings).toBeNull();
    expect(empty.settingsVersion).toMatch(/^[a-f0-9]{64}$/);
    expect((await read()).json().settingsVersion).toBe(empty.settingsVersion);
    const saved = await h.app.inject({
      method: 'PUT', url: '/api/workspaces/ws-empty/settings', headers: { cookie: h.adminCookie() },
      payload: { ...base, expectedVersion: empty.settingsVersion },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settingsVersion).not.toBe(empty.settingsVersion);
    expect((await read()).json().settingsVersion).toBe(saved.json().settingsVersion);
  });

  it('returns settings and their version from the same snapshot if another writer saves after this write', async () => {
    const loaded = (await get()).json();
    const save = h.store.saveSettings.bind(h.store);
    vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async (settings, options) => {
      await save(settings, options);
      const committed = await h.store.getSettings('ws-1');
      await save({ ...committed!, monthlyBudgetUsd: 75 });
    });
    const res = await put({ maxFindings: 20, expectedVersion: loaded.settingsVersion });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ maxFindings: 20, monthlyBudgetUsd: 75 });
    expect(res.json().settingsVersion).toBe((await get()).json().settingsVersion);
  });
});

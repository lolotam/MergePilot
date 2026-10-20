import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsChangedError } from '../core/types.js';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

describe('PUT /settings field-level concurrency', () => {
  let h: ProviderHarness;
  const required = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (patch: Record<string, unknown>) => h.app.inject({
    method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
    payload: { ...required, ...patch },
  });
  const snapshot = () => h.store.getSettings('ws-1');
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

  it('lets two cards save disjoint fields from the same snapshot without reverting either change', async () => {
    const base = await snapshot();
    expect((await put({ monthlyBudgetUsd: 75, base })).statusCode).toBe(200);
    const res = await put({ ...base, maxFindings: 20, base });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ monthlyBudgetUsd: 75, maxFindings: 20 });
    expect(await snapshot()).toMatchObject({ monthlyBudgetUsd: 75, maxFindings: 20 });
  });

  it('rejects a client-changed field that another writer changed since base, without writing', async () => {
    const base = await snapshot();
    await put({ monthlyBudgetUsd: 75 });
    const current = await snapshot();
    const save = vi.spyOn(h.store, 'saveSettings');
    const res = await put({ monthlyBudgetUsd: 100, maxFindings: 20, base });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(save).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(current);
  });

  it('keeps required fields changed elsewhere when a stale form resends them unchanged', async () => {
    const base = await snapshot();
    await put({ provider: 'openai', model: 'gpt-5', language: 'en' });
    const res = await put({ ...base, maxFindings: 20, base });
    expect(res.statusCode).toBe(200);
    expect(await snapshot()).toMatchObject({ provider: 'openai', model: 'gpt-5', language: 'en', maxFindings: 20 });
  });

  it('checks a composite field against the map it was derived from', async () => {
    const base = await snapshot();
    await put({ repoColors: { 'acme/one': 'teal' } });
    const current = await snapshot();
    const res = await put({ repoColors: { 'acme/two': 'sky' }, base: { repoColors: base?.repoColors } });
    expect(res.statusCode).toBe(409);
    expect(await snapshot()).toEqual(current);
  });

  it('retries a disjoint store race when the request carries a base', async () => {
    const base = await snapshot();
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...base!, monthlyBudgetUsd: 75 });
      throw new SettingsChangedError('ws-1');
    });
    const res = await put({ maxFindings: 20, base });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[1]).toEqual({ expected: { ...base, monthlyBudgetUsd: 75 } });
    expect(await snapshot()).toMatchObject({ monthlyBudgetUsd: 75, maxFindings: 20 });
  });

  it('rejects a store race without a base instead of replaying the stale write', async () => {
    const base = await snapshot();
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...base!, monthlyBudgetUsd: 75 });
      throw new SettingsChangedError('ws-1');
    });
    const res = await put({ maxFindings: 20 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual({ ...base, monthlyBudgetUsd: 75 });
  });

  it('rejects a store race when the base leaves sent fields unchecked', async () => {
    const base = await snapshot();
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...base!, model: 'claude-opus-5-5' });
      throw new SettingsChangedError('ws-1');
    });
    // Only maxFindings is baselined: the required provider/model/language are sent without one.
    const res = await put({ maxFindings: 20, base: { maxFindings: base!.maxFindings ?? null } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toMatchObject({ model: 'claude-opus-5-5' });
  });

  it('rejects a same-field store race after re-reading without retrying the stale write', async () => {
    const base = await snapshot();
    const read = vi.spyOn(h.store, 'getSettings');
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...base!, monthlyBudgetUsd: 75 });
      throw new SettingsChangedError('ws-1');
    });
    const res = await put({ monthlyBudgetUsd: 100, base });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await snapshot()).toEqual({ ...base, monthlyBudgetUsd: 75 });
  });

  it('stops after three store conflicts without writing', async () => {
    const base = await snapshot();
    const save = vi.spyOn(h.store, 'saveSettings').mockRejectedValue(new SettingsChangedError('ws-1'));
    const res = await put({ maxFindings: 20, base });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(conflict);
    expect(save).toHaveBeenCalledTimes(3);
    expect(await snapshot()).toEqual(base);
  });

  it('keeps legacy writes and fields missing from base unchecked', async () => {
    await put({ monthlyBudgetUsd: 75 });
    expect((await put({ monthlyBudgetUsd: 100, base: {} })).statusCode).toBe(200);
    expect((await snapshot())?.monthlyBudgetUsd).toBe(100);
    const res = await put({ monthlyBudgetUsd: 50 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('settingsVersion');
    expect((await snapshot())?.monthlyBudgetUsd).toBe(50);
  });

  it('does not store or return concurrency metadata', async () => {
    const base = await snapshot();
    const save = vi.spyOn(h.store, 'saveSettings');
    const res = await put({ maxFindings: 20, base });
    expect(res.statusCode).toBe(200);
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty('base');
    expect(await snapshot()).not.toHaveProperty('base');
    expect(res.json()).not.toHaveProperty('settingsVersion');
    expect(res.json().settings).not.toHaveProperty('base');
    const get = await h.app.inject({
      method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
    });
    expect(get.json()).not.toHaveProperty('settingsVersion');
  });

  it('revalidates the merged settings after a disjoint store race', async () => {
    const base = await snapshot();
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...base!, monthlyBudgetUsd: 5 });
      throw new SettingsChangedError('ws-1');
    });
    const res = await put({ perReviewUsd: 10, base });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual({ ...base, monthlyBudgetUsd: 5 });
  });
});

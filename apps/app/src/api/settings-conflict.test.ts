import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsChangedError } from '../core/types.js';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

describe('PUT /settings concurrent saves', () => {
  let h: ProviderHarness;
  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (patch: Record<string, unknown>) => h.app.inject({
    method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
    payload: { ...base, ...patch },
  });

  beforeEach(async () => {
    h = await createProviderHarness();
    expect((await put({ monthlyBudgetUsd: 50 })).statusCode).toBe(200);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('retries a conflict and preserves another writer\'s change to a different field', async () => {
    const previous = await h.store.getSettings('ws-1');
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...previous!, monthlyBudgetUsd: 75 });
      throw new SettingsChangedError('ws-1');
    });

    const res = await put({ maxFindings: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ monthlyBudgetUsd: 75, maxFindings: 20 });
    expect(await h.store.getSettings('ws-1')).toMatchObject({ monthlyBudgetUsd: 75, maxFindings: 20 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[1]).toEqual({ expected: previous });
    expect(spy.mock.calls[1]?.[1]).toEqual({ expected: { ...previous, monthlyBudgetUsd: 75 } });
  });

  it('returns settings_conflict after three conflicts and leaves settings unchanged', async () => {
    const previous = await h.store.getSettings('ws-1');
    const spy = vi.spyOn(h.store, 'saveSettings').mockRejectedValue(new SettingsChangedError('ws-1'));

    const res = await put({ maxFindings: 20 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: {
      code: 'settings_conflict', message: 'Settings changed while saving; reload and try again',
    } });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(await h.store.getSettings('ws-1')).toEqual(previous);
  });

  it('validates the patch again against fresh settings before retrying the write', async () => {
    const previous = await h.store.getSettings('ws-1');
    const save = h.store.saveSettings.bind(h.store);
    const spy = vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(async () => {
      await save({ ...previous!, monthlyBudgetUsd: 5 });
      throw new SettingsChangedError('ws-1');
    });

    const res = await put({ perReviewUsd: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({
      code: 'validation_error', message: 'perReviewUsd must not exceed monthlyBudgetUsd',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await h.store.getSettings('ws-1')).toEqual({ ...previous, monthlyBudgetUsd: 5 });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from './contract.js';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

// The workspace API spending cap per bot and its monthly-budget relation (ADR-0036).

describe('settings contract: perReviewUsd', () => {
  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };

  it('accepts the bounds and whole cents; omission stays a patch', () => {
    expect(SettingsUpdateSchema.parse(base).perReviewUsd).toBeUndefined();
    for (const perReviewUsd of [0.5, 1.15, 4.35, 10, 999.99, 1000, 1.15 + Number.EPSILON, 1.150000001]) {
      expect(SettingsUpdateSchema.parse({ ...base, perReviewUsd }).perReviewUsd).toBe(perReviewUsd);
    }
  });

  it.each([0, 0.49, 0.511, 1.001, 1.1500001, 1000.01, NaN, '10', null])('rejects %s', (perReviewUsd) => {
    expect(SettingsUpdateSchema.safeParse({ ...base, perReviewUsd }).success).toBe(false);
  });
});

describe('PUT /settings perReviewUsd', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (payload: Record<string, unknown>, ws = 'ws-1', cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/settings`, headers: { cookie }, payload: { ...base, ...payload } });
  const read = async (ws = 'ws-1', cookie = h.adminCookie()) =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/settings`, headers: { cookie } })).json().settings;

  it('reads back 0.5 until an admin picks another choice, which members can read but not write', async () => {
    expect((await put({})).statusCode).toBe(200);
    expect((await read()).perReviewUsd).toBe(0.5);

    const member = await put({ perReviewUsd: 30 }, 'ws-1', h.memberCookie());
    expect(member.statusCode).toBe(403);
    expect((await read()).perReviewUsd).toBe(0.5);

    expect((await put({ perReviewUsd: 30 })).statusCode).toBe(200);
    expect((await read('ws-1', h.memberCookie())).perReviewUsd).toBe(30);
  });

  it('refuses a value outside the bounds with validation_error and keeps the stored one', async () => {
    expect((await put({ perReviewUsd: 20 })).statusCode).toBe(200);
    for (const perReviewUsd of [0.49, 1001, 0.501]) {
      const res = await put({ perReviewUsd });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await read()).perReviewUsd).toBe(20);
  });

  it('a PUT that leaves it out keeps the stored value', async () => {
    expect((await put({ perReviewUsd: 45 })).statusCode).toBe(200);
    expect((await put({ minSeverity: 'high' })).statusCode).toBe(200);
    expect(await read()).toMatchObject({ perReviewUsd: 45, minSeverity: 'high' });
  });

  it('is kept per workspace', async () => {
    await h.addWorkspace('ws-2');
    expect((await put({ perReviewUsd: 40 })).statusCode).toBe(200);
    expect((await put({}, 'ws-2')).statusCode).toBe(200);
    expect((await read('ws-2')).perReviewUsd).toBe(0.5);

    expect((await put({ perReviewUsd: 10 }, 'ws-2')).statusCode).toBe(200);
    expect((await read('ws-1')).perReviewUsd).toBe(40);
    // The ws-1 member is no member of ws-2.
    expect((await put({ perReviewUsd: 50 }, 'ws-2', h.memberCookie())).statusCode).toBe(403);
    expect((await read('ws-2')).perReviewUsd).toBe(10);
  });
  it('checks the resulting monthly/per-review pair in both patch directions and allows clearing monthly', async () => {
    expect((await put({ monthlyBudgetUsd: 10, perReviewUsd: 3 })).statusCode).toBe(200);
    for (const patch of [{ perReviewUsd: 11 }, { monthlyBudgetUsd: 2 }]) {
      const res = await put(patch);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('perReviewUsd must not exceed monthlyBudgetUsd');
      expect(await read()).toMatchObject({ monthlyBudgetUsd: 10, perReviewUsd: 3 });
    }
    expect((await put({ monthlyBudgetUsd: 3 })).statusCode).toBe(200);
    expect((await put({ monthlyBudgetUsd: null, perReviewUsd: 1000 })).statusCode).toBe(200);
    expect(await read()).toMatchObject({ monthlyBudgetUsd: null, perReviewUsd: 1000 });
  });

  it('uses the default cap when validating a first monthly budget', async () => {
    expect((await put({ monthlyBudgetUsd: 0.49 })).statusCode).toBe(400);
    expect((await put({ monthlyBudgetUsd: 0.5 })).statusCode).toBe(200);
  });

});

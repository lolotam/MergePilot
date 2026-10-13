import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

const FETCHED = new Date('2026-10-13T02:30:00.000Z');

describe('model prices: route and overrides (ADR-0016)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
    for (const provider of ['anthropic', 'openai', 'xai', 'typesafe'] as const) {
      await h.credentials.saveKey({ workspaceId: 'ws-1', provider, apiKey: keyFor(provider), userId: 'u-admin' });
    }
    await h.store.replaceModelPrices(
      'models.dev',
      [
        { provider: 'anthropic', model: 'claude-x', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, source: 'models.dev' },
        { provider: 'openai', model: 'gpt-heavy', inputPerMTok: 5, outputPerMTok: 25, source: 'models.dev' },
        { provider: 'opencode-zen', model: 'jev-1.13-free', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
      ],
      FETCHED,
    );
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-x', language: 'en' };
  const put = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie }, payload: { ...base, ...payload } });
  const prices = (workspaceId = 'ws-1', cookie = h.memberCookie()) =>
    h.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/prices`, headers: { cookie } });

  it('lists every model the workspace uses with its catalog, override or unknown price', async () => {
    const judge = {
      enabled: true,
      provider: 'typesafe',
      model: 'jev-latest',
      mode: 'filter',
      threshold: 0.4,
      fallback: [{ provider: 'opencode-zen', model: 'jev-1.13-free' }, { provider: 'openrouter', model: '~typesafe/jev-latest' }],
    };
    const saved = await put({
      heavyProvider: 'openai',
      heavyModel: 'gpt-heavy',
      fallback: [{ provider: 'xai', model: 'grok-unpriced' }],
      judge,
      priceOverrides: [{ provider: 'typesafe', model: 'jev-latest', inputPerMTok: 0.05, outputPerMTok: 0 }],
    });
    expect(saved.statusCode).toBe(200);

    const res = await prices();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-x',
        role: 'primary',
        price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
        source: 'catalog:models.dev',
        fetchedAt: FETCHED.toISOString(),
        overridden: false,
      },
      {
        provider: 'openai',
        model: 'gpt-heavy',
        role: 'heavy',
        price: { inputPerMTok: 5, outputPerMTok: 25 },
        source: 'catalog:models.dev',
        fetchedAt: FETCHED.toISOString(),
        overridden: false,
      },
      { provider: 'xai', model: 'grok-unpriced', role: 'fallback', price: null, source: 'unknown', fetchedAt: null, overridden: false },
      {
        provider: 'typesafe',
        model: 'jev-latest',
        role: 'judge',
        price: { inputPerMTok: 0.05, outputPerMTok: 0 },
        source: 'override',
        fetchedAt: null,
        overridden: true,
      },
      {
        provider: 'opencode-zen',
        model: 'jev-1.13-free',
        role: 'judge-fallback',
        price: { inputPerMTok: 0, outputPerMTok: 0 },
        source: 'catalog:models.dev',
        fetchedAt: FETCHED.toISOString(),
        overridden: false,
      },
      {
        provider: 'openrouter',
        model: '~typesafe/jev-latest',
        role: 'judge-fallback',
        price: { inputPerMTok: 0.042, outputPerMTok: 0 },
        source: 'static',
        fetchedAt: null,
        overridden: false,
      },
    ]);
    expect(body.sources).toEqual([
      { source: 'openrouter', fetchedAt: null },
      { source: 'vercel', fetchedAt: null },
      { source: 'models.dev', fetchedAt: FETCHED.toISOString() },
    ]);
  });

  it('an override replaces the catalog price of a review model', async () => {
    await put({ priceOverrides: [{ provider: 'anthropic', model: 'claude-x', inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 1.25 }] });
    const [primary] = (await prices()).json().models;
    expect(primary).toMatchObject({
      role: 'primary',
      price: { inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 1.25 },
      source: 'override',
      overridden: true,
      fetchedAt: null,
    });
  });

  it('saves, keeps and clears overrides; only admins may change them', async () => {
    const overrides = [{ provider: 'custom', model: 'my-model', inputPerMTok: 0, outputPerMTok: 1000 }];
    expect((await put({ priceOverrides: overrides }, h.memberCookie())).statusCode).toBe(403);
    expect((await put({ priceOverrides: overrides })).statusCode).toBe(200);
    const read = async () =>
      (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.memberCookie() } })).json().settings
        .priceOverrides;
    expect(await read()).toEqual(overrides);
    expect((await put({ minSeverity: 'high' })).statusCode).toBe(200);
    expect(await read()).toEqual(overrides);
    expect((await put({ priceOverrides: [] })).statusCode).toBe(200);
    expect(await read()).toEqual([]);
  });

  it('rejects invalid overrides with a 400 and a field message', async () => {
    const entry = { provider: 'anthropic', model: 'claude-x', inputPerMTok: 1, outputPerMTok: 1 };
    const error = async (priceOverrides: unknown) => {
      const res = await put({ priceOverrides });
      expect(res.statusCode).toBe(400);
      return res.json().error as { code: string; message: string };
    };
    expect((await error([{ ...entry, provider: 'nope' }])).message).toContain('provider');
    expect((await error([{ ...entry, inputPerMTok: 1000.5 }])).message).toContain('inputPerMTok');
    expect((await error([{ ...entry, outputPerMTok: -1 }])).message).toContain('outputPerMTok');
    expect((await error([{ ...entry, cacheReadPerMTok: 'x' }])).message).toContain('cacheReadPerMTok');
    expect((await error([{ ...entry, model: ' ' }])).message).toContain('model');
    expect((await error([{ ...entry, extra: 1 }])).code).toBe('validation_error');
    expect((await error(Array.from({ length: 51 }, (_, i) => ({ ...entry, model: `m${i}` })))).message).toContain('at most 50');
    expect(await error([entry, { ...entry, model: 'CLAUDE-X' }])).toMatchObject({ code: 'price_override_duplicate' });
    expect((await error('all')).code).toBe('validation_error');
  });

  it('is readable by members only; a workspace without settings is 404', async () => {
    // Not a member of ws-2: the workspace guard answers 403 like every workspace route.
    expect((await prices('ws-2')).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/prices' })).statusCode).toBe(401);
    const res = await prices();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_configured');
  });
});

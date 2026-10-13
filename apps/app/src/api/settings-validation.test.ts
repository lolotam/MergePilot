import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

describe('PUT settings validation and key base URLs (J2)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie }, payload: { ...base, ...payload } });
  const errorCode = async (payload: Record<string, unknown>) => (await put(payload)).json().error?.code;

  it('saves a full J2 configuration and members may read but not write it', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });
    const settings = {
      effort: 'high',
      heavyProvider: 'openrouter',
      heavyModel: 'openai/gpt-5:free',
      heavyEffort: 'medium',
      heavyThresholdLines: 1200,
      fallback: [{ provider: 'openrouter', model: 'deepseek/deepseek-r1:free', effort: 'low' }],
      minSeverity: 'high',
    };
    expect((await put(settings, h.memberCookie())).statusCode).toBe(403);
    const res = await put(settings);
    expect(res.statusCode).toBe(200);
    const read = await h.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/settings',
      headers: { cookie: h.memberCookie() },
    });
    expect(read.json().settings).toMatchObject(settings);
  });

  it('needs a stored key for every fallback and for the heavy model', async () => {
    expect(await errorCode({ fallback: [{ provider: 'gemini', model: 'gemini-3.8-flash' }] })).toBe('fallback_key_missing');
    expect(await errorCode({ heavyProvider: 'openai', heavyModel: 'gpt-5' })).toBe('heavy_key_missing');
  });

  it('accepts Vercel AI Gateway as the main provider, a fallback and the heavy model once its key is stored', async () => {
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/vercel-gateway',
      headers: { cookie: h.adminCookie() },
      payload: { apiKey: keyFor('vg') },
    });
    expect(saved.statusCode).toBe(200);
    const settings = {
      provider: 'vercel-gateway',
      model: 'anthropic/claude-sonnet-4.5',
      effort: 'high',
      heavyProvider: 'vercel-gateway',
      heavyModel: 'openai/gpt-5',
      heavyThresholdLines: 900,
      fallback: [
        { provider: 'vercel-gateway', model: 'google/gemini-3-flash', effort: null },
        { provider: 'anthropic', model: 'claude-opus-5' },
      ],
    };
    expect((await put(settings)).statusCode).toBe(200);
    const read = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.memberCookie() } });
    expect(read.json().settings).toMatchObject(settings);
    // Its key also serves the Jev judge, with the Jev model only.
    expect((await put({ judge: { enabled: true, provider: 'vercel-gateway', model: 'typesafe-ai/jev', mode: 'filter', threshold: 0.4 } })).statusCode).toBe(200);
    expect(await errorCode({ judge: { enabled: true, provider: 'vercel-gateway', model: 'openai/gpt-5', mode: 'filter', threshold: 0.4 } })).toBe(
      'judge_model_invalid',
    );
  });

  it('keeps the heavy model all-or-nothing', async () => {
    expect(await errorCode({ heavyProvider: 'anthropic' })).toBe('validation_error');
    expect(await errorCode({ heavyModel: 'claude-opus-5' })).toBe('validation_error');
    expect(await errorCode({ heavyEffort: 'high' })).toBe('validation_error');
    expect(await errorCode({ heavyThresholdLines: 0, heavyProvider: 'anthropic', heavyModel: 'x' })).toBe('validation_error');
  });

  it('allows at most 3 fallbacks, none repeating the primary model or each other', async () => {
    const fb = (model: string) => ({ provider: 'anthropic', model });
    expect(await errorCode({ fallback: [fb('a'), fb('b'), fb('c'), fb('d')] })).toBe('validation_error');
    expect(await errorCode({ fallback: [fb('claude-sonnet-5-5')] })).toBe('fallback_duplicate');
    expect(await errorCode({ fallback: [fb('a'), fb('a')] })).toBe('fallback_duplicate');
    expect((await put({ fallback: [fb('a'), fb('b'), fb('c')] })).statusCode).toBe(200);
  });

  it('accepts only known severities and effort-shaped values', async () => {
    expect(await errorCode({ minSeverity: 'urgent' })).toBe('validation_error');
    expect(await errorCode({ effort: 'HIGH; drop' })).toBe('validation_error');
    expect((await put({ minSeverity: 'critical' })).json().settings.minSeverity).toBe('critical');
  });

  it('keys: a base URL is for custom only, https and public; a custom fallback then validates', async () => {
    const putKey = (provider: string, payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'PUT',
        url: `/api/workspaces/ws-1/keys/${provider}`,
        headers: { cookie: h.adminCookie() },
        payload,
      });
    const preset = await putKey('openai', { apiKey: keyFor('o'), baseUrl: 'https://llm.example.com/v1' });
    expect(preset.json().error.code).toBe('base_url_not_allowed');
    expect((await putKey('custom', { apiKey: keyFor('c') })).json().error.code).toBe('custom_base_url_required');
    const metadata = await putKey('custom', { apiKey: keyFor('c'), baseUrl: 'https://169.254.169.254/v1' });
    expect(metadata.json().error.code).toBe('ssrf_validation_error');

    const saved = await putKey('custom', { apiKey: keyFor('c'), baseUrl: 'https://llm.example.com/v1/' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().baseUrl).toBe('https://llm.example.com/v1');
    expect(saved.body).not.toContain(keyFor('c'));
    expect((await put({ fallback: [{ provider: 'custom', model: 'llama-3.3' }] })).statusCode).toBe(200);
  });

  it('PUT is a patch: omitted J2 fields keep their value, explicit null clears them', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });
    const full = {
      effort: 'high',
      heavyProvider: 'openrouter',
      heavyModel: 'openai/gpt-5:free',
      heavyEffort: 'medium',
      heavyThresholdLines: 1200,
      fallback: [{ provider: 'openrouter', model: 'z-ai/glm-5', effort: null }],
      minSeverity: 'high',
      monthlyBudgetUsd: 50,
    };
    expect((await put(full)).statusCode).toBe(200);
    const read = async () =>
      (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() } })).json()
        .settings;

    // An old client that only changes the budget.
    const budgetOnly = await put({ monthlyBudgetUsd: 75 });
    expect(budgetOnly.statusCode).toBe(200);
    expect(await read()).toMatchObject({ ...full, monthlyBudgetUsd: 75 });

    const cleared = await put({
      effort: null,
      heavyProvider: null,
      heavyModel: null,
      heavyEffort: null,
      heavyThresholdLines: null,
      fallback: null,
      minSeverity: null,
      monthlyBudgetUsd: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(await read()).toMatchObject({
      effort: null,
      heavyProvider: null,
      heavyModel: null,
      heavyEffort: null,
      fallback: [],
      minSeverity: 'medium',
      monthlyBudgetUsd: null,
    });
  });

  it('validates the merged result, so a patch cannot leave a heavy model without its provider', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });
    expect((await put({ heavyProvider: 'openrouter', heavyModel: 'm' })).statusCode).toBe(200);
    expect(await errorCode({ heavyProvider: null })).toBe('validation_error');
  });
});


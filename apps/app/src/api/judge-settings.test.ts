import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, testJudgeConnection: vi.fn(actual.testJudgeConnection) };
});

const { testJudgeConnection } = await import('@mergepilot/engine');

const judge = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  provider: 'typesafe',
  model: 'jev-latest',
  uses: ['annotate', 'filter', 'dedupe'],
  threshold: 0.4,
  fallback: [],
  ...overrides,
});

describe('Jev judge settings, keys and routes (ADR-0015)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = await createProviderHarness();
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en' };
  const put = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie }, payload: { ...base, ...payload } });
  const errorCode = async (payload: Record<string, unknown>) => (await put(payload)).json().error?.code;
  const read = async () =>
    (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.memberCookie() } })).json()
      .settings;
  const saveTypesafe = () =>
    h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/typesafe',
      headers: { cookie: h.adminCookie() },
      payload: { apiKey: keyFor('ts') },
    });

  it('stores a Jev-only key type, saves the judge with fallbacks, and members may only read it', async () => {
    expect((await saveTypesafe()).statusCode).toBe(200);
    const keys = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/keys', headers: { cookie: h.adminCookie() } });
    expect(keys.json().keys.map((k: { provider: string }) => k.provider)).toContain('typesafe');

    const value = judge({ fallback: [{ provider: 'opencode-zen', model: 'jev-1.13-free' }, { provider: 'openrouter', model: '~typesafe/jev-latest' }] });
    expect((await put({ judge: value }, h.memberCookie())).statusCode).toBe(403);
    expect((await put({ judge: value })).statusCode).toBe(200);
    expect((await read()).judge).toEqual(value);

    // Left out keeps it; null turns it off and clears it.
    expect((await put({ minSeverity: 'high' })).statusCode).toBe(200);
    expect((await read()).judge).toEqual(value);
    expect((await put({ judge: null })).statusCode).toBe(200);
    expect((await read()).judge).toBeNull();
  });

  it('saves zero or more uses, still maps the old mode, and rejects unknown uses', async () => {
    await saveTypesafe();
    const usesAfter = async (fields: Record<string, unknown>) => {
      const { uses: _uses, ...rest } = judge();
      const res = await put({ judge: { ...rest, ...fields } });
      expect(res.statusCode).toBe(200);
      return (await read()).judge.uses as string[];
    };
    expect(await usesAfter({ uses: ['dedupe', 'consensus', 'annotate', 'dedupe'] })).toEqual(['annotate', 'dedupe', 'consensus']);
    // Enabled with nothing to do is allowed: the judge is idle.
    expect(await usesAfter({ uses: [] })).toEqual([]);
    // Older web bundles send `mode`.
    expect(await usesAfter({ mode: 'off' })).toEqual(['dedupe']);
    expect(await usesAfter({ mode: 'annotate' })).toEqual(['annotate', 'dedupe']);
    expect(await usesAfter({ mode: 'filter' })).toEqual(['filter', 'dedupe']);
    expect(await usesAfter({ mode: 'filter', uses: ['annotate'] })).toEqual(['annotate']);
    expect((await read()).judge).not.toHaveProperty('mode');

    const { uses: _uses, ...noUses } = judge();
    expect(await errorCode({ judge: judge({ uses: ['annotate', 'loud'] }) })).toBe('validation_error');
    expect(await errorCode({ judge: judge({ mode: 'dedupe', uses: undefined }) })).toBe('validation_error');
    expect(await errorCode({ judge: noUses })).toBe('validation_error');
    expect((await read()).judge.uses).toEqual(['annotate']);
  });

  it('accepts only Jev models for each provider, at most 3 fallbacks and no repeats', async () => {
    await saveTypesafe();
    expect(await errorCode({ judge: judge({ model: 'gpt-5' }) })).toBe('judge_model_invalid');
    expect(await errorCode({ judge: judge({ provider: 'openrouter', model: 'openai/gpt-5' }) })).toBe('judge_model_invalid');
    expect(await errorCode({ judge: judge({ fallback: [{ provider: 'opencode-zen', model: 'glm-5.3' }] }) })).toBe('judge_model_invalid');
    const fb = { provider: 'opencode-zen', model: 'jev-1.13' };
    expect(await errorCode({ judge: judge({ fallback: [fb, fb, fb, fb] }) })).toBe('validation_error');
    expect(await errorCode({ judge: judge({ fallback: [fb, fb] }) })).toBe('judge_fallback_duplicate');
    expect(await errorCode({ judge: judge({ provider: 'nope' }) })).toBe('validation_error');
    expect(await errorCode({ judge: judge({ threshold: 1.5 }) })).toBe('validation_error');
  });

  it('needs a stored key for an enabled judge, not for a disabled one or its fallbacks', async () => {
    expect(await errorCode({ judge: judge() })).toBe('judge_key_missing');
    expect((await put({ judge: judge({ enabled: false }) })).statusCode).toBe(200);
    await saveTypesafe();
    expect((await put({ judge: judge({ fallback: [{ provider: 'vercel-gateway', model: 'typesafe-ai/jev' }] }) })).statusCode).toBe(200);
  });

  it('serves the fixed Jev-only model table to members', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/judge/providers', headers: { cookie: h.memberCookie() } });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual([
      { id: 'typesafe', label: 'TypeSafe', models: ['jev-latest'], keyOnly: true },
      { id: 'openrouter', label: 'OpenRouter', models: ['~typesafe/jev-latest', 'typesafe/jev-1.13'], keyOnly: false },
      { id: 'vercel-gateway', label: 'Vercel AI Gateway', models: ['typesafe-ai/jev'], keyOnly: false },
      { id: 'opencode-zen', label: 'OpenCode Zen', models: ['jev-1.13-free', 'jev-1.13'], keyOnly: false },
    ]);
  });

  describe('judge key test', () => {
    const test = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
      h.app.inject({ method: 'POST', url: '/api/workspaces/ws-1/judge/test', headers: { cookie }, payload });

    it('tests the stored key with the default Jev model', async () => {
      vi.mocked(testJudgeConnection).mockResolvedValue({ ok: true, ms: 33, model: 'jev-latest' });
      await saveTypesafe();
      const res = await test({ provider: 'typesafe' });
      expect(res.json()).toEqual({ ok: true, ms: 33, model: 'jev-latest' });
      const call = vi.mocked(testJudgeConnection).mock.calls.at(-1);
      expect(call?.[0]).toBe('typesafe');
      expect(call?.[1]).toBe(keyFor('ts'));
      expect(call?.[2]).toMatchObject({ model: 'jev-latest' });
    });

    it('tests an unsaved key and redacts it from the provider message', async () => {
      const key = keyFor('or');
      vi.mocked(testJudgeConnection).mockResolvedValue({ ok: false, ms: 5, code: 'model-not-found', message: `no model for ${key}` });
      const res = await test({ provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: key });
      expect(res.json()).toEqual({ ok: false, code: 'model-not-found', message: 'no model for [REDACTED]', ms: 5 });
      expect(await h.credentials.getCredential('ws-1', 'openrouter')).toBeNull();
    });

    it('rejects a non-Jev model, a missing key and a member', async () => {
      expect((await test({ provider: 'opencode-zen', model: 'glm-5.3' })).json().error.code).toBe('judge_model_invalid');
      expect((await test({ provider: 'vercel-gateway' })).statusCode).toBe(404);
      expect((await test({ provider: 'typesafe' }, h.memberCookie())).statusCode).toBe(403);
      expect(testJudgeConnection).not.toHaveBeenCalled();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, listModels: vi.fn(actual.listModels), testConnection: vi.fn(actual.testConnection) };
});

const { testConnection } = await import('@mergepilot/engine');

describe('connection test route (J2)', { timeout: 25000 }, () => {
  let h: ProviderHarness;
  const customFetch = vi.fn(async () => new Response('{}'));

  beforeEach(async () => {
    vi.clearAllMocks();
    h = await createProviderHarness(customFetch);
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const test = (provider: string, cookie: string, payload: unknown = {}) =>
    h.app.inject({ method: 'POST', url: `/api/workspaces/ws-1/credentials/${provider}/test`, headers: { cookie }, payload });
  const saveOpenAi = () =>
    h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('o'), userId: 'u-admin' });

  it('answers ok with latency and model for the stored key', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 120, model: 'gpt-5', reply: 'OK' });
    await saveOpenAi();
    const res = await test('openai', h.adminCookie(), { model: 'gpt-5', effort: 'high' });
    expect(res.json()).toEqual({ ok: true, ms: 120, model: 'gpt-5' });
    const call = vi.mocked(testConnection).mock.calls[0];
    expect(call?.[1]).toBe(keyFor('o'));
    expect(call?.[3]).toEqual({ effort: 'high', timeoutMs: 30000 });
  });

  it('answers ok:false with the category and a redacted message', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: false, ms: 45, code: 'auth', message: `bad key ${keyFor('o')}` });
    await saveOpenAi();
    const res = await test('openai', h.adminCookie());
    expect(res.json()).toEqual({ ok: false, code: 'auth', message: 'bad key [REDACTED]', ms: 45 });
  });

  it('tests an unsaved key before saving, without storing or echoing it', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 9, model: 'glm-5', reply: 'OK' });
    const key = keyFor('zai');
    const res = await test('zai-coding', h.adminCookie(), { apiKey: key, model: 'glm-5' });
    expect(res.json()).toEqual({ ok: true, ms: 9, model: 'glm-5' });
    expect(res.body).not.toContain(key);
    expect(vi.mocked(testConnection).mock.calls[0]?.[1]).toBe(key);
    expect(await h.credentials.getCredential('ws-1', 'zai-coding')).toBeNull();
  });

  it('uses the workspace model, else the provider default, and needs a model for custom', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model: 'x', reply: 'OK' });
    await saveOpenAi();
    await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/settings',
      headers: { cookie: h.adminCookie() },
      payload: { provider: 'openai', model: 'gpt-5-mini', language: 'en' },
    });
    await test('openai', h.adminCookie());
    expect(vi.mocked(testConnection).mock.calls[0]?.[2]).toBe('gpt-5-mini');

    await test('openrouter', h.adminCookie(), { apiKey: keyFor('or') });
    expect(vi.mocked(testConnection).mock.calls[1]?.[2]).not.toBe('');

    const custom = await test('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'https://llm.example.com/v1' });
    expect([custom.statusCode, custom.json().error.code]).toEqual([400, 'model_required']);
  });

  it('without a model, tests the custom key with the model the workspace uses it for (heavy, then fallback)', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 2, model: 'x', reply: 'OK' });
    await h.credentials.saveKey({
      workspaceId: 'ws-1',
      provider: 'custom',
      apiKey: keyFor('c'),
      userId: 'u-admin',
      baseUrl: 'https://llm.example.com/v1',
    });
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('o'), userId: 'u-admin' });
    const putSettings = (payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'PUT',
        url: '/api/workspaces/ws-1/settings',
        headers: { cookie: h.adminCookie() },
        payload: { provider: 'openai', model: 'gpt-5', language: 'en', ...payload },
      });
    expect((await putSettings({ fallback: [{ provider: 'custom', model: 'llama-fb' }] })).statusCode).toBe(200);
    expect((await test('custom', h.adminCookie())).json().ok).toBe(true);
    expect(vi.mocked(testConnection).mock.calls[0]?.[2]).toBe('llama-fb');

    expect((await putSettings({ heavyProvider: 'custom', heavyModel: 'llama-heavy' })).statusCode).toBe(200);
    await test('custom', h.adminCookie());
    expect(vi.mocked(testConnection).mock.calls[1]?.[2]).toBe('llama-heavy');
  });

  it('custom: calls through the guarded fetch, and refuses a private address', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 3, model: 'llama', reply: 'OK' });
    const ok = await test('custom', h.adminCookie(), {
      apiKey: keyFor('c'),
      baseUrl: 'https://llm.example.com/v1',
      model: 'llama',
    });
    expect(ok.json().ok).toBe(true);
    expect(vi.mocked(testConnection).mock.calls[0]?.[3]).toMatchObject({
      baseUrl: 'https://llm.example.com/v1',
      fetch: customFetch,
    });

    h.dns.address = '10.1.2.3';
    const blocked = await test('custom', h.adminCookie(), {
      apiKey: keyFor('c'),
      baseUrl: 'https://llm.example.com/v1',
      model: 'llama',
    });
    expect(blocked.json().error.code).toBe('ssrf_validation_error');
    expect(testConnection).toHaveBeenCalledTimes(1);
  });

  it('is for admins only and rate-limited to 10 per minute per workspace', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 10, model: 'gpt-5', reply: 'OK' });
    await saveOpenAi();
    expect((await test('openai', h.memberCookie())).statusCode).toBe(403);
    for (let i = 0; i < 10; i++) expect((await test('openai', h.adminCookie())).statusCode).toBe(200);
    const limited = await test('openai', h.adminCookie());
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmFailure } from '@mergepilot/engine';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, listModels: vi.fn(actual.listModels), testConnection: vi.fn(actual.testConnection) };
});

const { listModels } = await import('@mergepilot/engine');
const MODELS = [{ id: 'm-1', name: 'Model 1', efforts: ['low', 'high'] }];

describe('model catalog routes (J2)', { timeout: 25000 }, () => {
  let h: ProviderHarness;
  const customFetch = vi.fn(async () => new Response('{}'));

  beforeEach(async () => {
    vi.clearAllMocks();
    h = await createProviderHarness(customFetch);
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const get = (provider: string, cookie: string, query = '') =>
    h.app.inject({ method: 'GET', url: `/api/workspaces/ws-1/providers/${provider}/models${query}`, headers: { cookie } });
  const post = (provider: string, cookie: string, payload: unknown) =>
    h.app.inject({ method: 'POST', url: `/api/workspaces/ws-1/providers/${provider}/models`, headers: { cookie }, payload });

  it('lists models with the stored key, caches them 10 minutes, refreshes on ?refresh=true', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });

    const first = await get('anthropic', h.memberCookie());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ models: MODELS });
    expect(vi.mocked(listModels).mock.calls[0]?.[1]).toBe(keyFor('a'));
    await get('anthropic', h.memberCookie());
    expect(listModels).toHaveBeenCalledTimes(1);
    await get('anthropic', h.memberCookie(), '?refresh=true');
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('lists Vercel AI Gateway models with its stored key', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'vercel-gateway', apiKey: keyFor('vg'), userId: 'u-admin' });
    const res = await get('vercel-gateway', h.memberCookie());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: MODELS });
    expect(vi.mocked(listModels).mock.calls[0]?.[0]).toBe('vercel-gateway');
    expect(vi.mocked(listModels).mock.calls[0]?.[1]).toBe(keyFor('vg'));
  });

  it('drops the cached list when the key is replaced', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('o1'), userId: 'u-admin' });
    await get('openai', h.memberCookie());
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openai',
      headers: { cookie: h.adminCookie() },
      payload: { apiKey: keyFor('o2') },
    });
    expect(put.statusCode).toBe(200);
    await get('openai', h.memberCookie());
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('answers 404 key_not_found without a stored key and 400 for an unknown provider', async () => {
    expect((await get('openai', h.memberCookie())).json().error.code).toBe('key_not_found');
    expect((await get('claude-code', h.memberCookie())).statusCode).toBe(400);
  });

  it('lists models for an unsaved key without storing or echoing it; members may not', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    const key = keyFor('unsaved');
    expect((await post('openrouter', h.memberCookie(), { apiKey: key })).statusCode).toBe(403);

    const res = await post('openrouter', h.adminCookie(), { apiKey: key });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: MODELS });
    expect(res.body).not.toContain(key);
    expect(await h.credentials.getCredential('ws-1', 'openrouter')).toBeNull();
  });

  it('maps failures to a category and redacts the key from the message', async () => {
    const key = keyFor('bad');
    vi.mocked(listModels).mockRejectedValueOnce(
      new LlmFailure({ code: 'INVALID_CREDENTIAL', message: `Auth failed with key ${key}` }),
    );
    const auth = await post('zai-coding', h.adminCookie(), { apiKey: key });
    expect(auth.statusCode).toBe(422);
    expect(auth.json().error.code).toBe('auth');
    expect(auth.body).not.toContain(key);

    vi.mocked(listModels).mockRejectedValueOnce(new LlmFailure({ code: 'QUOTA', message: 'no credit' }));
    const quota = await post('openrouter', h.adminCookie(), { apiKey: key });
    expect([quota.statusCode, quota.json().error.code]).toEqual([429, 'quota']);

    vi.mocked(listModels).mockRejectedValueOnce(new Error(`socket closed for ${key}`));
    const other = await post('openrouter', h.adminCookie(), { apiKey: key });
    expect([other.statusCode, other.json().error.code]).toEqual([502, 'models_fetch_failed']);
    expect(other.body).not.toContain(key);
  });

  it('refuses a base URL for a preset provider', async () => {
    const res = await post('openai', h.adminCookie(), { apiKey: keyFor('o'), baseUrl: 'https://llm.example.com/v1' });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'base_url_not_allowed']);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('custom: refuses http and private addresses, and calls a public URL through the guarded fetch', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    const http = await post('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'http://llm.example.com/v1' });
    expect(http.json().error.code).toBe('ssrf_validation_error');
    const loop = await post('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'https://127.0.0.1:11434/v1' });
    expect(loop.json().error.code).toBe('ssrf_validation_error');

    const ok = await post('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'https://llm.example.com/v1/' });
    expect(ok.statusCode).toBe(200);
    const options = vi.mocked(listModels).mock.calls[0]?.[2];
    expect(options?.baseUrl).toBe('https://llm.example.com/v1');
    expect(options?.fetch).toBe(customFetch);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('custom: re-checks the stored URL at call time (DNS rebinding after the key was saved)', async () => {
    vi.mocked(listModels).mockResolvedValue(MODELS);
    await h.credentials.saveKey({
      workspaceId: 'ws-1',
      provider: 'custom',
      apiKey: keyFor('c'),
      userId: 'u-admin',
      baseUrl: 'https://llm.example.com/v1',
    });
    h.dns.address = '169.254.169.254';
    const res = await get('custom', h.memberCookie());
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'ssrf_validation_error']);
    expect(listModels).not.toHaveBeenCalled();
  });
});

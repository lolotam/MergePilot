import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFetchTimeoutError } from '../core/safe-fetch.js';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, listModels: vi.fn(actual.listModels), testConnection: vi.fn(actual.testConnection) };
});

const { listModels, testConnection, LlmFailure } = await import('@mergepilot/engine');

describe('connection test route (J2)', { timeout: 25000 }, () => {
  let h: ProviderHarness;
  const customFetch = vi.fn(async () => new Response('{}'));

  beforeEach(async () => {
    vi.clearAllMocks();
    // No real network in tests: model listing (used to pick a test model) fails fast unless a test mocks it.
    vi.mocked(listModels).mockRejectedValue(new Error('offline in tests'));
    h = await createProviderHarness(customFetch);
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const test = (provider: string, cookie: string, payload: string | object = {}) =>
    h.app.inject({ method: 'POST', url: `/api/workspaces/ws-1/credentials/${provider}/test`, headers: { cookie }, payload });
  const saveOpenAi = () =>
    h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('o'), userId: 'u-admin' });

  it('answers ok with latency and model for the stored key', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 120, model: 'gpt-5', reply: 'OK' });
    await saveOpenAi();
    const res = await test('openai', h.adminCookie(), { model: 'gpt-5', effort: 'high' });
    expect(res.json()).toEqual({ ok: true, ms: 120, model: 'gpt-5', quotaStatus: 'valid' });
    const call = vi.mocked(testConnection).mock.calls[0];
    expect(call?.[1]).toBe(keyFor('o'));
    expect(call?.[3]).toEqual({ effort: 'high', timeoutMs: 30000 });
  });

  it('answers ok:false with the category and a redacted message', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: false, ms: 45, code: 'auth', message: `bad key ${keyFor('o')}` });
    await saveOpenAi();
    const res = await test('openai', h.adminCookie());
    expect(res.json()).toEqual({ ok: false, code: 'auth', message: 'bad key [REDACTED]', ms: 45, quotaStatus: 'invalid' });
  });

  it('tests an unsaved key before saving, without storing or echoing it', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 9, model: 'glm-5', reply: 'OK' });
    const key = keyFor('zai');
    const res = await test('zai-coding', h.adminCookie(), { apiKey: key, model: 'glm-5' });
    expect(res.json()).toEqual({ ok: true, ms: 9, model: 'glm-5', quotaStatus: 'valid' });
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

    vi.mocked(listModels).mockResolvedValueOnce([{ id: 'account-model', name: 'Account model', efforts: [] }]);
    await test('openrouter', h.adminCookie(), { apiKey: keyFor('or') });
    expect(vi.mocked(testConnection).mock.calls[1]?.[2]).toBe('account-model');
    expect(vi.mocked(listModels).mock.lastCall?.[2]).toMatchObject({ strictRefresh: true });

    const custom = await test('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'https://llm.example.com/v1' });
    expect([custom.statusCode, custom.json().error.code]).toEqual([400, 'model_required']);
  });

  it('prefers a FREE model when none is configured for OpenRouter (:free) or OpenCode Zen (free)', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model: 'x', reply: 'OK' });
    vi.mocked(listModels).mockImplementation(async (provider) => {
      if (provider === 'openrouter') {
        return [
          { id: 'openai/gpt-5', name: 'GPT 5', efforts: [] },
          { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 Free', efforts: [] },
        ];
      }
      if (provider === 'opencode-zen') {
        return [
          { id: 'glm-5.3', name: 'GLM 5.3', efforts: [] },
          { id: 'glm-4-free', name: 'GLM 4 Free', efforts: [] },
        ];
      }
      return [];
    });

    await test('openrouter', h.adminCookie(), { apiKey: keyFor('or') });
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('meta-llama/llama-3.3-70b-instruct:free');

    await test('opencode-zen', h.adminCookie(), { apiKey: keyFor('zen') });
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('glm-4-free');
  });

  it.each([
    { failure: 'INVALID_CREDENTIAL', code: 'auth' },
    { failure: 'QUOTA', code: 'quota' },
    { failure: 'RATE_LIMIT', code: 'rate-limit' },
  ] as const)('does not change key health from an OpenRouter catalog failure ($failure)', async ({ failure, code }) => {
    const provider = 'openrouter';
    const key = await h.credentials.appendProviderKey({
      workspaceId: 'ws-1', provider, apiKey: keyFor('or'), userId: 'u-admin',
    });
    const previousTest = new Date('2026-01-01T00:00:00Z');
    await h.credentials.recordKeyTest('ws-1', provider, key.id, 'valid', previousTest);
    vi.mocked(listModels).mockRejectedValueOnce(new LlmFailure({ code: failure, provider, message: 'fixture failure' }));
    const result = await test(provider, h.adminCookie(), { keyId: key.id });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, code });
    expect(result.json()).not.toHaveProperty('quotaStatus');
    expect(testConnection).not.toHaveBeenCalled();
    const [stored] = await h.store.listProviderKeys('ws-1', provider);
    expect(stored?.lastTestStatus).toBe('valid');
    expect(stored?.lastTestedAt).toEqual(previousTest);
  });

  it('returns the inference result when recording the stored key status fails', async () => {
    const provider = 'openrouter';
    const slot = await h.credentials.appendProviderKey({ workspaceId: 'ws-1', provider, apiKey: keyFor('slot'), userId: 'u-admin' });
    vi.mocked(testConnection).mockResolvedValueOnce({ ok: false, code: 'auth', ms: 1, message: 'fixture inference failure' });
    const write = vi.spyOn(h.credentials, 'recordKeyTest').mockRejectedValueOnce(new Error('fixture storage error'));
    const response = await test(provider, h.adminCookie(), { keyId: slot.id, model: 'fixture' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, code: 'auth' });
    expect(response.json()).not.toHaveProperty('quotaStatus');
    expect(write).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledTimes(1);
  });

  it('selects from the tested slot catalog and still honors an explicit model', async () => {
    const provider = 'openrouter';
    const headers = { cookie: h.adminCookie() };
    const saved = await h.app.inject({
      method: 'PUT', url: '/api/workspaces/ws-1/settings', headers,
      payload: { provider, model: 'openai/workspace-default', language: 'en' },
    });
    expect(saved.statusCode).toBe(200);
    const defaultSlot = await h.credentials.appendProviderKey({
      workspaceId: 'ws-1', provider, apiKey: keyFor('default'), userId: 'u-admin',
    });
    const slot = await h.credentials.appendProviderKey({ workspaceId: 'ws-1', provider, apiKey: keyFor('slot'), userId: 'u-admin' });
    const model = 'openai/account:free';
    vi.mocked(listModels).mockResolvedValueOnce([{ id: model, name: 'Account model', efforts: [] }]);
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model, reply: 'OK' });

    expect((await test(provider, h.adminCookie(), { keyId: slot.id })).statusCode).toBe(200);
    expect(listModels).toHaveBeenCalledWith(provider, keyFor('slot'), expect.objectContaining({ strictRefresh: true }));
    expect(testConnection).toHaveBeenLastCalledWith(provider, keyFor('slot'), model, expect.anything());
    const stored = await h.store.listProviderKeys('ws-1', provider);
    expect(stored.find(({ id }) => id === slot.id)?.lastTestStatus).toBe('valid');
    expect(stored.find(({ id }) => id === defaultSlot.id)?.lastTestStatus).toBeNull();

    await test(provider, h.adminCookie(), { keyId: slot.id, model: 'openai/explicit' });
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenLastCalledWith(provider, keyFor('slot'), 'openai/explicit', expect.anything());
  });

  it.each(['empty', 'server', 'denied'] as const)('uses a configured OpenAI model for a slot if discovery is %s', async (discovery) => {
    const provider = 'openai';
    const slot = await h.credentials.appendProviderKey({ workspaceId: 'ws-1', provider, apiKey: keyFor('slot'), userId: 'u-admin' });
    const model = 'gpt-5-mini';
    const settings = await h.app.inject({
      method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() },
      payload: { provider, model, language: 'en' },
    });
    expect(settings.statusCode).toBe(200);
    if (discovery === 'empty') vi.mocked(listModels).mockResolvedValueOnce([]);
    else {
      const code = discovery === 'denied' ? 'INVALID_CREDENTIAL' : 'SERVER';
      vi.mocked(listModels).mockRejectedValueOnce(new LlmFailure({ code, provider, message: 'fixture failure' }));
    }
    vi.mocked(testConnection).mockResolvedValueOnce({ ok: true, ms: 1, model, reply: 'OK' });
    const response = await test(provider, h.adminCookie(), { keyId: slot.id });
    expect(response.json()).toMatchObject({ ok: true, model });
    expect(testConnection).toHaveBeenLastCalledWith(provider, keyFor('slot'), model, expect.anything());
  });

  it('keeps the key status unchanged when the slot has no catalog model to test', async () => {
    const provider = 'gemini';
    const slot = await h.credentials.appendProviderKey({ workspaceId: 'ws-1', provider, apiKey: keyFor('slot'), userId: 'u-admin' });
    vi.mocked(listModels).mockResolvedValueOnce([]);
    const response = await test(provider, h.adminCookie(), { keyId: slot.id });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('model_required');
    expect(testConnection).not.toHaveBeenCalled();
    const [stored] = await h.store.listProviderKeys('ws-1', provider);
    expect(stored?.lastTestStatus).toBeNull();
  });

  it('never caches an unsaved key catalog, and skips a retired default the provider no longer lists', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model: 'x', reply: 'OK' });
    vi.mocked(listModels).mockResolvedValue([{ id: 'mimo-v2.6', name: 'MiMo v2.6', efforts: [] }]);

    await test('xiaomi', h.adminCookie(), { apiKey: keyFor('xa') });
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('mimo-v2.6');
    await test('xiaomi', h.adminCookie(), { apiKey: keyFor('xb') });
    // Each unsaved key lists its own models: nothing was served from the workspace cache.
    expect(vi.mocked(listModels)).toHaveBeenCalledTimes(2);
  });

  it('keeps a connection test catalog out of subsequent picker responses', async () => {
    const testModels = [{ id: 'test-account-model', name: 'Test model', efforts: [] }];
    const pickerModels = [{ id: 'picker-account-model', name: 'Picker model', efforts: [] }];
    vi.mocked(listModels).mockResolvedValueOnce(pickerModels).mockResolvedValueOnce(testModels);
    vi.mocked(testConnection).mockResolvedValueOnce({ ok: true, ms: 1, model: 'test-account-model', reply: 'OK' });
    await saveOpenAi();
    const getPicker = () => h.app.inject({
      method: 'GET', url: '/api/workspaces/ws-1/providers/openai/models', headers: { cookie: h.memberCookie() },
    });
    expect((await getPicker()).json()).toEqual({ models: pickerModels });
    expect((await test('openai', h.adminCookie())).statusCode).toBe(200);
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('test-account-model');
    expect((await getPicker()).json()).toEqual({ models: pickerModels });
  });

  it('returns a classified timeout without testing a model when listing times out', async () => {
    await saveOpenAi();
    vi.mocked(listModels).mockRejectedValueOnce(new LlmFailure({
      code: 'TIMEOUT', provider: 'openai', message: 'fixture timeout',
    }));
    const result = await test('openai', h.adminCookie());
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, code: 'network', message: 'Provider model catalog did not answer in time' });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('reports guarded custom catalog timeouts without falling back to a model', async () => {
    const engine = await vi.importActual<typeof import('@mergepilot/engine')>('@mergepilot/engine');
    vi.mocked(listModels).mockImplementationOnce(engine.listModels);
    customFetch.mockRejectedValueOnce(new SafeFetchTimeoutError('fixture idle timeout'));
    const result = await test('custom', h.adminCookie(), { apiKey: keyFor('c'), baseUrl: 'https://llm.example.com/v1' });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ ok: false, code: 'network', message: 'Provider model catalog did not answer in time' });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('falls back to the registry default when listing models fails', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model: 'x', reply: 'OK' });
    vi.mocked(listModels).mockRejectedValue(new Error('boom'));
    const res = await test('xiaomi', h.adminCookie(), { apiKey: keyFor('xc') });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('mimo-v2.5');
  });

  it('tests a MiniMax key with the registry default model', async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 1, model: 'x', reply: 'OK' });
    vi.mocked(listModels).mockRejectedValue(new Error('boom'));
    const res = await test('minimax', h.adminCookie(), { apiKey: keyFor('mm') });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testConnection).mock.lastCall?.[2]).toBe('MiniMax-M3.1-Flash');
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSubscriptionAvailable, loginSubscription, refreshSubscription } from './auth.js';
import { ANTIGRAVITY_CLIENT_ID_ENV, ANTIGRAVITY_CLIENT_SECRET_ENV } from './antigravity/index.js';

afterEach(() => vi.unstubAllGlobals());
describe('headless subscription login', () => {
  it('uses Codex device login and retains the ChatGPT account id', async () => {
    const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'device-private', user_code: 'ABCD-EFGH', interval: '0' });
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'authorization-code', code_verifier: 'pkce' });
      return Response.json({ access_token: access, refresh_token: ['refresh', 'test'].join('-'), expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn(async () => { throw new Error('No browser callback prompt expected'); });
    const notify = vi.fn();
    const result = await loginSubscription('openai', { prompt, notify });
    expect(prompt).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device' }));
    expect(result).toMatchObject({ type: 'oauth', access, accountId: 'account-test', refresh: 'refresh-test' });
  });

  it('uses Claude copy-code login with PKCE and validates state', async () => {
    let authorizeUrl = '';
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.redirect_uri).toBe('https://platform.claude.com/oauth/code/callback');
      expect(body.code_verifier).toBe(new URL(authorizeUrl).searchParams.get('state'));
      return Response.json({ access_token: ['claude', 'access'].join('-'), refresh_token: ['claude', 'refresh'].join('-'), expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await loginSubscription('anthropic', {
      notify(event) { if (event.type === 'auth_url') authorizeUrl = event.url; },
      async prompt(prompt) { expect(prompt.type).toBe('manual_code'); return `code#${new URL(authorizeUrl).searchParams.get('state')}`; },
    });
    expect(result.access).toBe('claude-access');
    await expect(loginSubscription('anthropic', { notify: () => undefined, prompt: async () => 'code#wrong-state' })).rejects.toThrow(/state mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('relays the Grok device code and aborts polling when the user cancels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ device_code: 'private-device', user_code: 'GROK-CODE', verification_uri: 'https://auth.x.ai/device', expires_in: 600, interval: 1 })));
    const controller = new AbortController();
    const notify = vi.fn(() => controller.abort());
    await expect(loginSubscription('xai', { signal: controller.signal, notify, prompt: async () => '' })).rejects.toThrow();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'device_code', userCode: 'GROK-CODE' }));
  });
});

describe('Google Antigravity availability', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is offered only when both OAuth client values are configured', () => {
    expect(isSubscriptionAvailable('google-antigravity', {})).toBe(false);
    expect(isSubscriptionAvailable('google-antigravity', { [ANTIGRAVITY_CLIENT_ID_ENV]: 'fake-id' })).toBe(false);
    expect(isSubscriptionAvailable('google-antigravity', { [ANTIGRAVITY_CLIENT_ID_ENV]: 'fake-id', [ANTIGRAVITY_CLIENT_SECRET_ENV]: 'fake-secret' })).toBe(true);
    expect(isSubscriptionAvailable('openai', {})).toBe(true);
  });

  it('refuses to sign in or refresh without the client configuration, before any request', async () => {
    vi.stubEnv(ANTIGRAVITY_CLIENT_ID_ENV, '');
    vi.stubEnv(ANTIGRAVITY_CLIENT_SECRET_ENV, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginSubscription('google-antigravity', { notify: () => undefined, prompt: async () => '' })).rejects.toThrow(/not configured/);
    await expect(refreshSubscription('google-antigravity', { type: 'oauth', access: 'a', refresh: 'r', expires: 0 }, new AbortController().signal))
      .rejects.toThrow('Subscription token refresh failed; sign in again');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

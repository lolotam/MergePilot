import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionCredential } from '../../credentials/subscription.js';
import { isSubscriptionAvailable, loginSubscription, refreshSubscription, SubscriptionRefreshError } from './auth.js';
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

describe('Anthropic subscription refresh', () => {
  const storedAccess = ['claude', 'access', 'stored'].join('-');
  const storedRefresh = ['claude', 'refresh', 'stored'].join('-');
  const rotatedAccess = ['claude', 'access', 'rotated'].join('-');
  const rotatedRefresh = ['claude', 'refresh', 'rotated'].join('-');
  const credential: SubscriptionCredential = { type: 'oauth', access: storedAccess, refresh: storedRefresh, expires: Date.now() + 3_600_000 };

  it('sends the stored refresh token to the token endpoint and returns the rotated credential', async () => {
    let sent: { url: string; init?: RequestInit } | undefined;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      sent = { url: String(input), init };
      return Response.json({ access_token: rotatedAccess, refresh_token: rotatedRefresh, expires_in: 28800 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const result = await refreshSubscription('anthropic', credential, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent?.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(sent?.init?.method).toBe('POST');
    const body = JSON.parse(String(sent?.init?.body)) as Record<string, string>;
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe(storedRefresh);
    expect(body.client_id).toEqual(expect.any(String));
    expect(body.client_id).not.toBe('');
    expect(result.access).toBe(rotatedAccess);
    expect(result.refresh).toBe(rotatedRefresh);
    expect(Math.abs(result.expires - (before + 28_800_000 - 5 * 60_000))).toBeLessThanOrEqual(5_000);
  });

  it('reports a refused refresh as a sign-in failure and keeps the response body out of the error', async () => {
    const marker = ['token', 'response', 'body', 'marker'].join('-');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: marker }), { status: 400 })));

    const failure = await refreshSubscription('anthropic', credential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('sign-in');
    expect(error.status).toBe(400);
    expect(error.oauthError).toBe('invalid_grant');
    expect(error.transient).toBe(false);
    expect(error.message).toBe('Subscription token refresh failed; sign in again');
    const visible = JSON.stringify({ message: error.message, status: error.status, oauthError: error.oauthError, reason: error.reason });
    expect(visible).not.toContain(marker);
    expect(visible).not.toContain(storedRefresh);
    expect(visible).not.toContain('platform.claude.com');
  });

  it.each([408, 429, 503])('treats an HTTP %i answer as a retryable failure', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'server_error' }), { status })));

    const failure = await refreshSubscription('anthropic', credential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.status).toBe(status);
    expect(error.transient).toBe(true);
  });

  it('treats a network failure as a retryable failure without a status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const failure = await refreshSubscription('anthropic', credential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.status).toBeUndefined();
    expect(error.transient).toBe(true);
  });

  it('drops diagnostics that are not a plain status or error code', () => {
    const error = new SubscriptionRefreshError('sign-in', { status: 42, oauthError: 'Bad Value!' });

    expect(error.status).toBeUndefined();
    expect(error.oauthError).toBeUndefined();
    expect(error.message).toBe('Subscription token refresh failed; sign in again');
  });
});

// pi-ai reports a failed refresh in three different shapes, one per provider: Anthropic writes
// `status=400`, Codex `token refresh failed (400)` and xAI `refresh failed (HTTP 400)`.
describe('pi-ai refresh failure formats', () => {
  const codexAccess = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } })).toString('base64url')}.signature`;
  const codexRefresh = ['codex', 'refresh', 'stored'].join('-');
  const codexCredential: SubscriptionCredential = { type: 'oauth', access: codexAccess, refresh: codexRefresh, expires: Date.now() + 3_600_000, accountId: 'account-test' };
  const xaiRefresh = ['xai', 'refresh', 'stored'].join('-');
  const xaiCredential: SubscriptionCredential = { type: 'oauth', access: ['xai', 'access', 'stored'].join('-'), refresh: xaiRefresh, expires: Date.now() + 3_600_000 };

  it('reads the status and the OAuth code out of a refused Codex refresh', async () => {
    const marker = ['codex', 'token', 'body', 'marker'].join('-');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: marker }), { status: 400 })));

    const failure = await refreshSubscription('openai', codexCredential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('sign-in');
    expect(error.status).toBe(400);
    expect(error.oauthError).toBe('invalid_grant');
    expect(error.transient).toBe(false);
    const visible = JSON.stringify({ message: error.message, status: error.status, oauthError: error.oauthError, reason: error.reason });
    expect(visible).not.toContain(marker);
    expect(visible).not.toContain(codexRefresh);
  });

  it('treats a rate-limited Codex refresh as a retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limit' }), { status: 429 })));

    const failure = await refreshSubscription('openai', codexCredential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.status).toBe(429);
    expect(error.transient).toBe(true);
  });

  it('reads the status out of a refused xAI refresh', async () => {
    const marker = ['xai', 'token', 'body', 'marker'].join('-');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: marker }), { status: 400 })));

    const failure = await refreshSubscription('xai', xaiCredential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('sign-in');
    expect(error.status).toBe(400);
    expect(error.transient).toBe(false);
    const visible = JSON.stringify({ message: error.message, status: error.status, oauthError: error.oauthError, reason: error.reason });
    expect(visible).not.toContain(marker);
    expect(visible).not.toContain(xaiRefresh);
  });

  it('treats an xAI server error as a retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 503 })));

    const failure = await refreshSubscription('xai', xaiCredential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.status).toBe(503);
    expect(error.transient).toBe(true);
  });

  // Our own 30-second deadline: pi-ai rethrows the abort without a status, so the failure must not
  // look like a refused sign-in the credential service would remember as `sign_in_required_at`.
  it('treats a refresh our own deadline cut short as a retryable failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    }));

    const failure = await refreshSubscription('xai', xaiCredential, controller.signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.transient).toBe(true);
  });

  it('treats a refresh pi-ai cut short by its own timeout as a retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); }));

    const failure = await refreshSubscription('openai', codexCredential, new AbortController().signal).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SubscriptionRefreshError);
    const error = failure as SubscriptionRefreshError;
    expect(error.reason).toBe('unreachable');
    expect(error.transient).toBe(true);
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

  it('reports a missing client configuration as a server problem, not a sign-in to redo, before any request', async () => {
    vi.stubEnv(ANTIGRAVITY_CLIENT_ID_ENV, '');
    vi.stubEnv(ANTIGRAVITY_CLIENT_SECRET_ENV, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loginSubscription('google-antigravity', { notify: () => undefined, prompt: async () => '' }))
      .rejects.toMatchObject({ name: 'SubscriptionLoginError', reason: 'not-configured' });
    await expect(refreshSubscription('google-antigravity', { type: 'oauth', access: 'a', refresh: 'r', expires: 0 }, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'not-configured', message: 'Google Antigravity sign-in is not configured on this server' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

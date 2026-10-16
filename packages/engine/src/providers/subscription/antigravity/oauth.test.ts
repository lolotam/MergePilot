import { describe, expect, it, vi } from 'vitest';
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai';
import {
  ANTIGRAVITY_REDIRECT_URI,
  authorizationUrl,
  codeFromPastedUrl,
  createPkce,
  loginAntigravity,
  refreshAntigravity,
  SubscriptionLoginError,
  type AntigravityDeps,
} from './oauth.js';

const client = { clientId: ['fake', 'client', 'id'].join('-'), clientSecret: ['fake', 'client', 'secret'].join('-') };
const access = ['fake', 'access', 'token'].join('-');
const refresh = ['fake', 'refresh', 'token'].join('-');

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function deps(routes: Record<string, Route>): { deps: AntigravityDeps; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (!key) throw new Error(`unexpected request ${url}`);
    return routes[key]!(url, init ?? {});
  });
  return { deps: { client, fetch: fetchMock as unknown as typeof fetch, now: () => 1_000_000, sleep: async () => undefined }, calls };
}

function interaction(paste: (authUrl: string) => string) {
  let authUrl = '';
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  return {
    events,
    prompts,
    value: {
      notify(event: AuthEvent) { events.push(event); if (event.type === 'auth_url') authUrl = event.url; },
      async prompt(prompt: AuthPrompt) { prompts.push(prompt); return paste(authUrl); },
    },
  };
}

function redirectFor(authUrl: string, overrides: Record<string, string> = {}): string {
  const state = new URL(authUrl).searchParams.get('state') ?? '';
  return `${ANTIGRAVITY_REDIRECT_URI}?${new URLSearchParams({ state, code: 'auth-code-1', ...overrides }).toString()}`;
}

const tokenOk: Route = () => Response.json({ access_token: access, refresh_token: refresh, expires_in: 3599 });

describe('Antigravity authorization URL', () => {
  it('asks for an offline code with PKCE S256, state and the loopback redirect', () => {
    const pkce = createPkce();
    const url = new URL(authorizationUrl(client, pkce));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(client.clientId);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('state')).toBe(pkce.state);
    expect(url.searchParams.get('redirect_uri')).toBe(ANTIGRAVITY_REDIRECT_URI);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });
});

describe('codeFromPastedUrl', () => {
  it('returns the code when the state matches', () => {
    expect(codeFromPastedUrl(`${ANTIGRAVITY_REDIRECT_URI}?state=s1&code=c1`, 's1')).toBe('c1');
  });

  it.each([
    ['another sign-in', `${ANTIGRAVITY_REDIRECT_URI}?state=other&code=c1`, 'state-mismatch'],
    ['no state', `${ANTIGRAVITY_REDIRECT_URI}?code=c1`, 'state-mismatch'],
    ['no code', `${ANTIGRAVITY_REDIRECT_URI}?state=s1`, 'invalid-paste'],
    ['a bare code', 'c1', 'invalid-paste'],
    ['a refusal', `${ANTIGRAVITY_REDIRECT_URI}?state=s1&error=access_denied`, 'denied'],
  ])('rejects %s', (_name, pasted, reason) => {
    expect(() => codeFromPastedUrl(pasted, 's1')).toThrow(expect.objectContaining({ reason }));
  });
});

describe('loginAntigravity', () => {
  it('exchanges the pasted code with the verifier and stores the existing project and tier', async () => {
    const { deps: d, calls } = deps({
      '/token': tokenOk,
      ':loadCodeAssist': () => Response.json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-123' }),
    });
    const login = interaction((authUrl) => redirectFor(authUrl));
    const credential = await loginAntigravity(login.value, d);

    expect(credential).toEqual({ type: 'oauth', access, refresh, expires: 1_000_000 + 3_599_000, projectId: 'project-123', tier: 'free-tier' });
    expect(login.events[0]).toMatchObject({ type: 'auth_url' });
    expect(login.prompts[0]).toMatchObject({ type: 'text' });
    const token = new URLSearchParams(String(calls[0]!.init.body));
    const challenge = new URL((login.events[0] as { url: string }).url).searchParams.get('code_challenge');
    expect(token.get('grant_type')).toBe('authorization_code');
    expect(token.get('code')).toBe('auth-code-1');
    expect(token.get('redirect_uri')).toBe(ANTIGRAVITY_REDIRECT_URI);
    expect(token.get('client_secret')).toBe(client.clientSecret);
    expect(token.get('code_verifier')).toBeTruthy();
    expect(token.get('code_verifier')).not.toBe(challenge);
    const load = calls[1]!;
    expect(new Headers(load.init.headers).get('authorization')).toBe(`Bearer ${access}`);
    expect(JSON.parse(String(load.init.body))).toMatchObject({ metadata: { ideType: 'ANTIGRAVITY' } });
  });

  it('onboards a new account on the default tier and polls until the operation is done', async () => {
    let polls = 0;
    const { deps: d, calls } = deps({
      '/token': tokenOk,
      ':loadCodeAssist': () => Response.json({ allowedTiers: [{ id: 'standard-tier' }, { id: 'free-tier', isDefault: true }] }),
      ':onboardUser': () => Response.json(++polls < 3 ? { done: false } : { done: true, response: { cloudaicompanionProject: { id: 'project-new' } } }),
    });
    const credential = await loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, d);
    expect(credential).toMatchObject({ projectId: 'project-new', tier: 'free-tier' });
    expect(polls).toBe(3);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toMatchObject({ tierId: 'free-tier' });
  });

  it.each([
    ['validation is required', { ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] }, 'validation-required'],
    ['no tier is offered', { ineligibleTiers: [{ reasonCode: 'INELIGIBLE_ACCOUNT' }] }, 'ineligible'],
    ['the tier needs a Cloud project', { allowedTiers: [{ id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true }] }, 'project-required'],
    ['a tier without a project', { currentTier: { id: 'standard-tier' } }, 'project-required'],
  ])('fails with a fixed reason when %s', async (_name, loaded, reason) => {
    const { deps: d } = deps({ '/token': tokenOk, ':loadCodeAssist': () => Response.json(loaded) });
    await expect(loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, d)).rejects.toMatchObject({ reason });
  });

  it('turns a 403 verification answer from loadCodeAssist into validation-required without keeping the body', async () => {
    const { deps: d } = deps({
      '/token': tokenOk,
      ':loadCodeAssist': () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'VALIDATION_REQUIRED https://example.test/verify' } }, { status: 403 }),
    });
    const failure = await loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, d).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubscriptionLoginError);
    expect(failure).toMatchObject({ reason: 'validation-required' });
    expect(String((failure as Error).message)).not.toContain('example.test');
  });

  it('reports a Code Assist outage as a generic failure, not as an ineligible account', async () => {
    const { deps: d } = deps({ '/token': tokenOk, ':loadCodeAssist': () => new Response('unavailable', { status: 503 }) });
    const failure = await loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, d).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SubscriptionLoginError);
  });

  it('rejects a mismatched paste before any token request', async () => {
    const { deps: d, calls } = deps({ '/token': tokenOk });
    await expect(loginAntigravity(interaction((authUrl) => redirectFor(authUrl, { state: 'forged' })).value, d))
      .rejects.toMatchObject({ reason: 'state-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('fails when Google refuses the code or sends no refresh token, without echoing the body', async () => {
    const refused = deps({ '/token': () => new Response(JSON.stringify({ error: 'invalid_grant', echo: client.clientSecret }), { status: 400 }) });
    const error = await loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, refused.deps).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: 'token-exchange' });
    expect(String((error as Error).message)).not.toContain(client.clientSecret);

    const noRefresh = deps({ '/token': () => Response.json({ access_token: access, expires_in: 3600 }) });
    await expect(loginAntigravity(interaction((authUrl) => redirectFor(authUrl)).value, noRefresh.deps)).rejects.toMatchObject({ reason: 'token-exchange' });
  });
});

describe('refreshAntigravity', () => {
  const stored = { type: 'oauth' as const, access: 'old-access', refresh, expires: 1, projectId: 'project-123', tier: 'free-tier' };

  it('keeps the refresh token and project when Google sends only a new access token', async () => {
    const { deps: d, calls } = deps({ '/token': () => Response.json({ access_token: 'new-access', expires_in: 3600 }) });
    const next = await refreshAntigravity(stored, d, new AbortController().signal);
    expect(next).toEqual({ ...stored, access: 'new-access', expires: 1_000_000 + 3_600_000 });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(refresh);
  });

  it('stores a rotated refresh token', async () => {
    const { deps: d } = deps({ '/token': () => Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }) });
    expect((await refreshAntigravity(stored, d, new AbortController().signal)).refresh).toBe('rotated-refresh');
  });

  it('fails on invalid_grant', async () => {
    const { deps: d } = deps({ '/token': () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
    await expect(refreshAntigravity(stored, d, new AbortController().signal)).rejects.toBeInstanceOf(SubscriptionLoginError);
  });
});

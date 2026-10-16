import { afterEach, describe, expect, it } from 'vitest';
import { decodeSubscription, SubscriptionLoginError, type SubscriptionCredential } from '@mergepilot/engine';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';
import type { SubscriptionAvailability, SubscriptionLogin } from './contract-subscriptions.js';

const access = ['fake', 'google', 'access'].join('-');
const refresh = ['fake', 'google', 'refresh'].join('-');
const credential: SubscriptionCredential = { type: 'oauth', access, refresh, expires: Date.now() + 3_600_000, projectId: 'project-1', tier: 'free-tier' };
const root = '/api/workspaces/ws-1/subscriptions';
const GOOD_PASTE = 'http://localhost:51121/oauth-callback?state=s&code=c';

let harness: ProviderHarness;
afterEach(async () => harness.close());

async function start(available: boolean): Promise<ProviderHarness> {
  harness = await createProviderHarness(undefined, async (provider, interaction) => {
    if (provider !== 'google-antigravity') throw new Error('unexpected provider');
    interaction.notify({ type: 'auth_url', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' });
    const pasted = await interaction.prompt({ type: 'text', message: 'Paste the address' });
    // A provider body never reaches the dashboard: only the fixed reason does.
    if (pasted !== GOOD_PASTE) throw new SubscriptionLoginError('state-mismatch');
    return credential;
  }, (provider) => provider !== 'google-antigravity' || available);
  return harness;
}

async function answer(cookie: string, id: string, value: string): Promise<SubscriptionLogin> {
  const url = `${root}/sessions/${id}`;
  const state = (await harness.app.inject({ method: 'GET', url, headers: { cookie } })).json<SubscriptionLogin>();
  await harness.app.inject({ method: 'POST', url: `${url}/input`, headers: { cookie }, payload: { promptId: state.prompt!.id, value } });
  for (let i = 0; i < 20; i++) {
    const next = (await harness.app.inject({ method: 'GET', url, headers: { cookie } })).json<SubscriptionLogin>();
    if (next.status !== 'pending') return next;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('login did not settle');
}

describe('Google Antigravity subscription routes', () => {
  it('lists the provider only when the server has its OAuth client, for admins only', async () => {
    await start(false);
    expect((await harness.app.inject({ method: 'GET', url: root, headers: { cookie: harness.memberCookie() } })).statusCode).toBe(403);
    const off = await harness.app.inject({ method: 'GET', url: root, headers: { cookie: harness.adminCookie() } });
    expect(off.json<SubscriptionAvailability>().providers).toEqual(['openai', 'anthropic', 'xai']);
    const refused = await harness.app.inject({
      method: 'POST', url: `${root}/google-antigravity`, headers: { cookie: harness.adminCookie() }, payload: { acknowledgedTerms: true },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('invalid_provider');
    await harness.close();

    await start(true);
    const on = await harness.app.inject({ method: 'GET', url: root, headers: { cookie: harness.adminCookie() } });
    expect(on.json<SubscriptionAvailability>().providers).toContain('google-antigravity');
  });

  it('requires the terms acknowledgement before a sign-in starts', async () => {
    await start(true);
    const cookie = harness.adminCookie();
    for (const payload of [{}, { acknowledgedTerms: false }]) {
      const response = await harness.app.inject({ method: 'POST', url: `${root}/google-antigravity`, headers: { cookie }, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('terms_not_acknowledged');
    }
    expect((await harness.app.inject({ method: 'POST', url: `${root}/google-antigravity`, headers: { cookie: harness.memberCookie() }, payload: { acknowledgedTerms: true } })).statusCode).toBe(403);
  });

  it('saves the encrypted envelope with its project on finish, and shows no token', async () => {
    await start(true);
    const cookie = harness.adminCookie();
    const started = (await harness.app.inject({ method: 'POST', url: `${root}/google-antigravity`, headers: { cookie }, payload: { acknowledgedTerms: true } })).json<SubscriptionLogin>();
    expect(started.provider).toBe('google-antigravity');
    const ready = await answer(cookie, started.id, GOOD_PASTE);
    expect(ready.status).toBe('ready');
    expect(await harness.store.getCredential('ws-1', 'google-antigravity')).toBeNull();

    const finished = await harness.app.inject({ method: 'POST', url: `${root}/sessions/${started.id}/finish`, headers: { cookie } });
    expect(finished.json<SubscriptionLogin>().status).toBe('completed');
    const stored = await harness.store.getCredential('ws-1', 'google-antigravity');
    expect(stored?.ciphertext).not.toContain(access);
    const envelope = decodeSubscription((await harness.credentials.resolve('ws-1', 'google-antigravity')).reveal(), 'google-antigravity');
    expect(envelope?.credential).toMatchObject({ access, refresh, projectId: 'project-1' });

    const keys = await harness.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/keys', headers: { cookie } });
    expect(keys.json().keys.find((key: { provider: string }) => key.provider === 'google-antigravity')?.authMethod).toBe('subscription');
    expect(keys.body).not.toContain(access);
    expect(keys.body).not.toContain(refresh);
  });

  it('reports a failed sign-in with its fixed reason only', async () => {
    await start(true);
    const cookie = harness.adminCookie();
    const started = (await harness.app.inject({ method: 'POST', url: `${root}/google-antigravity`, headers: { cookie }, payload: { acknowledgedTerms: true } })).json<SubscriptionLogin>();
    const failed = await answer(cookie, started.id, 'http://localhost:51121/oauth-callback?state=forged&code=c');
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'state-mismatch' });
    expect(await harness.store.getCredential('ws-1', 'google-antigravity')).toBeNull();
  });

  it('refuses an API key for the subscription-only provider', async () => {
    await start(true);
    const response = await harness.app.inject({
      method: 'PUT', url: '/api/workspaces/ws-1/keys/google-antigravity', headers: { cookie: harness.adminCookie() },
      payload: { apiKey: ['AIza', 'fake', 'key', '000000000'].join('') },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('subscription_only');
    expect(await harness.store.getCredential('ws-1', 'google-antigravity')).toBeNull();
  });
});

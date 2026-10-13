import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';
import type { SubscriptionLogin } from './contract-subscriptions.js';

let harness: ProviderHarness;
const credential: SubscriptionCredential = { type: 'oauth', access: 'test-access-secret', refresh: 'test-refresh-secret', expires: Date.now() + 3_600_000 };
const root = '/api/workspaces/ws-1/subscriptions';
beforeEach(async () => {
  harness = await createProviderHarness(undefined, async (provider, interaction) => {
    if (provider === 'anthropic') {
      interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=test' });
      const input = await interaction.prompt({ type: 'manual_code', message: 'Code' });
      if (input !== 'valid-code') throw new Error('Invalid code with sensitive response body');
    } else interaction.notify({ type: 'device_code', userCode: 'TEST-CODE', verificationUri: 'https://auth.x.ai/device' });
    return credential;
  });
});
afterEach(async () => harness.close());

describe('subscription REST login', () => {
  it('requires admin role and rejects unsupported providers', async () => {
    expect((await harness.app.inject({ method: 'POST', url: `${root}/openai` })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: 'POST', url: `${root}/openai`, headers: { cookie: harness.memberCookie() } })).statusCode).toBe(403);
    expect((await harness.app.inject({ method: 'POST', url: `${root}/gemini`, headers: { cookie: harness.adminCookie() } })).statusCode).toBe(400);
  });

  it('isolates sessions by workspace, persists only on authenticated finish, and returns no tokens', async () => {
    const cookie = harness.adminCookie();
    const start = await harness.app.inject({ method: 'POST', url: `${root}/xai`, headers: { cookie } });
    const state = start.json<SubscriptionLogin>();
    expect(start.statusCode).toBe(200);
    await harness.addWorkspace('ws-2');
    const sessionUrl = `${root}/sessions/${state.id}`;
    expect((await harness.app.inject({ method: 'GET', url: sessionUrl.replace('ws-1', 'ws-2'), headers: { cookie } })).statusCode).toBe(404);
    expect(await harness.store.getCredential('ws-1', 'xai')).toBeNull();
    const poll = await harness.app.inject({ method: 'GET', url: sessionUrl, headers: { cookie } });
    expect(poll.json<SubscriptionLogin>().status).toBe('ready');
    expect(poll.body).not.toContain(credential.access);
    expect(poll.body).not.toContain(credential.refresh);
    expect((await harness.app.inject({ method: 'POST', url: `${sessionUrl}/finish`, headers: { cookie } })).json<SubscriptionLogin>().status).toBe('completed');
    const resolved = await harness.credentials.resolve('ws-1', 'xai');
    expect(decodeSubscription(resolved.reveal())?.credential.access).toBe(credential.access);
    const keys = await harness.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/keys', headers: { cookie } });
    expect(keys.json().keys[0].authMethod).toBe('subscription');
    expect(keys.body).not.toContain(credential.access);
    expect((await harness.app.inject({ method: 'POST', url: `${sessionUrl}/finish`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('accepts Claude copy-code input only for the current prompt, and cancels without saving', async () => {
    const cookie = harness.adminCookie();
    const start = await harness.app.inject({ method: 'POST', url: `${root}/anthropic`, headers: { cookie } });
    const id = start.json<SubscriptionLogin>().id;
    const url = `${root}/sessions/${id}`;
    const state = (await harness.app.inject({ method: 'GET', url, headers: { cookie } })).json<SubscriptionLogin>();
    expect(state.prompt).toBeDefined();
    expect((await harness.app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie } })).statusCode).toBe(409);
    const input = { promptId: state.prompt!.id, value: 'valid-code' };
    expect((await harness.app.inject({ method: 'POST', url: `${url}/input`, headers: { cookie }, payload: input })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: 'POST', url: `${url}/input`, headers: { cookie }, payload: input })).statusCode).toBe(409);
    await harness.app.inject({ method: 'DELETE', url, headers: { cookie } });
    expect((await harness.app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie } })).statusCode).toBe(409);
    expect(await harness.store.getCredential('ws-1', 'anthropic')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { PROVIDER_AUTH_LIMIT } from './provider-auth-routes.js';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

const credential = (): SubscriptionCredential => ({
  type: 'oauth', access: ['test', 'access', '1111'].join('-'), refresh: ['test', 'refresh'].join('-'), expires: Date.now() + 3_600_000,
});

describe('dual-method auth routes (ADR-0027)', { timeout: 60000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const admin = () => ({ cookie: h.adminCookie() });
  const member = () => ({ cookie: h.memberCookie() });

  it('refuses unsigned, member and missing-method requests without leaking secrets', async () => {
    const sub = encodeSubscription('openai', credential());
    await h.credentials.saveSubscription('ws-1', 'openai', credential(), 'u-admin');
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('o'), userId: 'u-admin' });

    const unsigned = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openai/default-method',
      payload: { method: 'api-key' },
    });
    expect(unsigned.statusCode).toBe(401);

    const asMember = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openai/default-method',
      headers: member(),
      payload: { method: 'api-key' },
    });
    expect(asMember.statusCode).toBe(403);

    const ok = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openai/default-method',
      headers: admin(),
      payload: { method: 'api-key' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.body).not.toContain(sub);
    expect(ok.body).not.toContain('refresh');
  });

  it('isolates workspaces on default-method updates', async () => {
    await h.addWorkspace('ws-2');
    await h.credentials.saveSubscription('ws-1', 'openai', credential(), 'u-admin');
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey: keyFor('w1'), userId: 'u-admin' });
    await h.credentials.setProviderDefaultMethod('ws-1', 'openai', 'subscription');
    await h.credentials.saveKey({ workspaceId: 'ws-2', provider: 'openai', apiKey: keyFor('w2'), userId: 'u-admin' });
    await h.credentials.saveSubscription('ws-2', 'openai', credential(), 'u-admin');
    const other = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-2/keys/openai/default-method',
      headers: admin(),
      payload: { method: 'api-key' },
    });
    expect(other.statusCode).toBe(204);
    expect(await h.store.getProviderAuthPreference('ws-2', 'openai')).toBe('api-key');
    expect(await h.store.getProviderAuthPreference('ws-1', 'openai')).toBe('subscription');
  });

  it('returns 400 when default-method body omits method', async () => {
    await h.credentials.saveSubscription('ws-1', 'openai', credential(), 'u-admin');
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openai/default-method',
      headers: admin(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('disconnect subscription: refuses unsigned, member and missing subscription', async () => {
    await h.credentials.saveSubscription('ws-1', 'anthropic', credential(), 'u-admin');
    await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'anthropic',
      apiKey: keyFor('slot'),
      userId: 'u-admin',
    });

    const unsigned = await h.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-1/keys/anthropic/subscription',
    });
    expect(unsigned.statusCode).toBe(401);

    const asMember = await h.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-1/keys/anthropic/subscription',
      headers: member(),
    });
    expect(asMember.statusCode).toBe(403);

    await h.credentials.disconnectSubscription('ws-1', 'anthropic');
    const again = await h.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-1/keys/anthropic/subscription',
      headers: admin(),
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'no_subscription' } });
  });

  it('disconnect subscription succeeds for admin and keeps API key slots', async () => {
    await h.credentials.saveSubscription('ws-1', 'xai', credential(), 'u-admin');
    const slot = await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'xai',
      apiKey: keyFor('xai'),
      userId: 'u-admin',
    });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-1/keys/xai/subscription',
      headers: admin(),
    });
    expect(res.statusCode).toBe(204);
    expect((await h.store.getCredential('ws-1', 'xai'))?.id).toBe(slot.id);
    expect(await h.store.listProviderKeys('ws-1', 'xai')).toHaveLength(1);
  });

  it('rate-limits default-method changes per workspace before touching the credential', async () => {
    await h.addWorkspace('ws-2');
    for (const ws of ['ws-1', 'ws-2']) {
      await h.credentials.saveSubscription(ws, 'openai', credential(), 'u-admin');
      await h.credentials.appendProviderKey({ workspaceId: ws, provider: 'openai', apiKey: keyFor(ws), userId: 'u-admin' });
    }
    const put = (ws: string, method: string) => h.app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws}/keys/openai/default-method`,
      headers: admin(),
      payload: { method },
    });
    for (let i = 0; i < PROVIDER_AUTH_LIMIT; i++) expect((await put('ws-1', 'api-key')).statusCode).toBe(204);
    const limited = await put('ws-1', 'subscription');
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    expect(await h.store.getProviderAuthPreference('ws-1', 'openai')).toBe('api-key');
    expect((await put('ws-2', 'api-key')).statusCode).toBe(204);
  });

  it('rate-limits subscription disconnects per workspace', async () => {
    const del = () => h.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-1/keys/anthropic/subscription',
      headers: admin(),
    });
    for (let i = 0; i < PROVIDER_AUTH_LIMIT; i++) expect((await del()).statusCode).toBe(400);
    await h.credentials.saveSubscription('ws-1', 'anthropic', credential(), 'u-admin');
    const limited = await del();
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    expect(await h.credentials.hasConnectedSubscription('ws-1', 'anthropic')).toBe(true);
  });
});

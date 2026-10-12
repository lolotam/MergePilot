import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

describe('settings: run retention and repository colors (ADR-0014)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie }, payload: { ...base, ...payload } });
  const read = async () =>
    (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.memberCookie() } })).json()
      .settings;

  it('defaults retention to 30 days, accepts 30/90/180/365/forever and keeps it when left out', async () => {
    expect((await put({})).statusCode).toBe(200);
    expect((await read()).runRetentionDays).toBe(30);

    expect((await put({ runRetentionDays: null })).statusCode).toBe(200);
    expect((await read()).runRetentionDays).toBeNull();
    expect((await put({ model: 'claude-opus-5' })).statusCode).toBe(200);
    expect((await read()).runRetentionDays).toBeNull();

    expect((await put({ runRetentionDays: 365 })).statusCode).toBe(200);
    expect((await read()).runRetentionDays).toBe(365);
    for (const bad of [0, 45, -30, '90']) {
      const res = await put({ runRetentionDays: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await put({ runRetentionDays: 90 }, h.memberCookie())).statusCode).toBe(403);
    expect((await read()).runRetentionDays).toBe(365);
  });

  it('stores repo colors from the fixed palette only; members cannot change them', async () => {
    expect((await put({ repoColors: { 'acme/api': 'violet', 'acme/web.site': 'teal' } })).statusCode).toBe(200);
    expect((await read()).repoColors).toEqual({ 'acme/api': 'violet', 'acme/web.site': 'teal' });

    // Left out keeps the map; a new map replaces it ("Auto" = the repo is left out).
    expect((await put({ runRetentionDays: 90 })).statusCode).toBe(200);
    expect((await read()).repoColors).toEqual({ 'acme/api': 'violet', 'acme/web.site': 'teal' });
    expect((await put({ repoColors: { 'acme/api': 'violet' } })).statusCode).toBe(200);
    expect((await read()).repoColors).toEqual({ 'acme/api': 'violet' });

    const tooMany = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`org/repo-${i}`, 'sky']));
    for (const bad of [
      { 'acme/api': 'red; background:url(x)' },
      { 'acme/api': '#ff0000' },
      { 'not a repo': 'sky' },
      { '../etc': 'sky' },
      tooMany,
    ]) {
      const res = await put({ repoColors: bad });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await put({ repoColors: { 'acme/api': 'rose' } }, h.memberCookie())).statusCode).toBe(403);
    expect((await read()).repoColors).toEqual({ 'acme/api': 'violet' });
  });
});

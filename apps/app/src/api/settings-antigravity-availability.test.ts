import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

const offered = { google: false };
let h: ProviderHarness;
beforeEach(async () => {
  offered.google = false;
  h = await createProviderHarness(undefined, undefined, (provider) => provider !== 'google-antigravity' || offered.google);
});
afterEach(async () => h.close());

const settings = (provider: string) => ({ provider, model: 'gemini-3.8-flash', language: 'en' });
const putSettings = (body: unknown) =>
  h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() }, payload: body });
const putBot = (provider: string) =>
  h.app.inject({
    method: 'PUT', url: '/api/workspaces/ws-1/bots/2', headers: { cookie: h.adminCookie() },
    payload: { name: 'Owl', logo: 'owl', provider, model: 'gemini-3.8-flash' },
  });

describe('Google Antigravity choices when the server does not offer it (ADR-0032)', () => {
  it('refuses a new main-bot choice with a clear error', async () => {
    const response = await putSettings(settings('google-antigravity'));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'provider_unavailable', message: expect.stringMatching(/Google Antigravity sign-in is not configured/) });
    expect(await h.store.getSettings('ws-1')).toBeNull();
  });

  it('refuses a new extra-bot choice', async () => {
    const response = await putBot('google-antigravity');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('provider_unavailable');
  });

  it('keeps a choice saved while it was offered, so other settings can still be saved', async () => {
    offered.google = true;
    expect((await putSettings(settings('google-antigravity'))).statusCode).toBe(200);
    expect((await putBot('google-antigravity')).statusCode).toBe(200);
    offered.google = false;
    expect((await putSettings({ ...settings('google-antigravity'), language: 'ar' })).statusCode).toBe(200);
    expect((await putBot('google-antigravity')).statusCode).toBe(200);
  });
});

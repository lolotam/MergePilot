import { PRICE_SOURCE_URLS, type FetchLike } from '@mergepilot/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { adminTestConfig, createSeededAdminApp, fixtureToken, type AdminTestDb } from './admin.fixtures.js';

const priceFetch = (async (url: string) => {
  if (url === PRICE_SOURCE_URLS.openrouter) {
    return new Response(JSON.stringify({ data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }] }));
  }
  if (url === PRICE_SOURCE_URLS['models.dev']) {
    return new Response(JSON.stringify({ anthropic: { models: { m: { id: 'm', cost: { input: 3, output: 15 } } } } }));
  }
  return new Response('down', { status: 503 });
}) as FetchLike;

describe('admin maintenance: refresh model prices', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let adminCookie: string;

  beforeEach(async () => {
    ({ app, handle, adminCookie } = await createSeededAdminApp({ priceFetch }));
  }, 30000);

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  const lastRun = async () =>
    (await app.inject({ method: 'GET', url: '/api/admin/maintenance', headers: { cookie: adminCookie } })).json().prices.lastRun;
  const refresh = (cookie?: string) =>
    app.inject({ method: 'POST', url: '/api/admin/maintenance/refresh-prices', ...(cookie ? { headers: { cookie } } : {}) });

  it('refreshes the prices, records the run with its count and error, and shows it as the last run', async () => {
    expect(await lastRun()).toBeNull();
    const res = await refresh(adminCookie);
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();

    await vi.waitFor(async () => expect((await lastRun())?.finishedAt).not.toBeNull());
    expect(await lastRun()).toMatchObject({ id: runId, deletedCount: 2, error: 'vercel: HTTP 503' });
    expect(await handle.store.getModelPrice('anthropic', 'm')).toMatchObject({ inputPerMTok: 3, source: 'models.dev' });
    // The retention job's last run is separate.
    const body = (await app.inject({ method: 'GET', url: '/api/admin/maintenance', headers: { cookie: adminCookie } })).json();
    expect(body.retention.lastRun).toBeNull();
  });

  it('answers 409 while a refresh holds the lease', async () => {
    expect(await handle.store.startMaintenanceRun('refresh-prices', new Date(0))).not.toBeNull();
    const res = await refresh(adminCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_running');
  });

  it('is hidden (404) from anyone who is not a platform admin', async () => {
    const regular = signedSessionCookie(fixtureToken('regular'), adminTestConfig([]).authSecret);
    expect((await refresh(regular)).statusCode).toBe(404);
    expect((await refresh()).statusCode).toBe(404);
    expect(await handle.store.getLatestMaintenanceRun('refresh-prices')).toBeNull();
  });
});

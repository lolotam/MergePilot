import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { reviewRuns } from '../db/schema.js';
import { adminTestConfig, createSeededAdminApp, fixtureToken, type AdminTestDb } from './admin.fixtures.js';

// Seed: three runs created now (completed, failed, queued) in ws-1 / ws-2, no settings rows
// (so the 30-day default retention applies).
describe('admin maintenance: run retention', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let adminCookie: string;

  beforeEach(async () => {
    ({ app, handle, adminCookie } = await createSeededAdminApp());
  }, 30000);

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  const lastRun = async () =>
    (await app.inject({ method: 'GET', url: '/api/admin/maintenance', headers: { cookie: adminCookie } })).json()
      .retention.lastRun;
  const runNow = () =>
    app.inject({ method: 'POST', url: '/api/admin/maintenance/run-retention', headers: { cookie: adminCookie } });

  it('starts a cleanup, records it, and shows it as the last run', async () => {
    expect(await lastRun()).toBeNull();
    await handle.db.update(reviewRuns).set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

    const res = await runNow();
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();

    await vi.waitFor(async () => expect((await lastRun())?.finishedAt).not.toBeNull());
    const last = await lastRun();
    expect(last).toMatchObject({ id: runId, deletedCount: 2, error: null });
    // The queued run is never deleted.
    expect((await handle.db.select().from(reviewRuns)).map((r) => r.status)).toEqual(['queued']);
  });

  it('answers 409 while a cleanup holds the lease', async () => {
    const held = await handle.store.startMaintenanceRun('retention', new Date(0));
    expect(held).not.toBeNull();
    const res = await runNow();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_running');
  });

  it('is hidden (404) from anyone who is not a platform admin', async () => {
    const regular = signedSessionCookie(fixtureToken('regular'), adminTestConfig([]).authSecret);
    for (const req of [
      { method: 'GET' as const, url: '/api/admin/maintenance' },
      { method: 'POST' as const, url: '/api/admin/maintenance/run-retention' },
    ]) {
      expect((await app.inject({ ...req, headers: { cookie: regular } })).statusCode).toBe(404);
      expect((await app.inject(req)).statusCode).toBe(404);
    }
    expect(await handle.store.getLatestMaintenanceRun('retention')).toBeNull();
  });
});

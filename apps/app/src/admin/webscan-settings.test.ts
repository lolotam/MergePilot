import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SCAN_LIMITS,
  limitsConfirmationDigest,
} from '@mergepilot/webscan';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

describe('web-scan settings routes (Task 8A)', () => {
  const config = adminTestConfig(['admin@mergepilot.com']);
  const adminCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
  const masterKey = randomBytes(32).toString('base64');

  const events: WebScanEventBus = {
    publish: () => {},
    subscribe: async () => () => {},
    close: async () => {},
  };

  let app: FastifyInstance;
  let handle: AdminTestDb;

  beforeEach(async () => {
    handle = await createAdminTestDb();
    const auth: Auth = createAuth({ db: handle.db, config });
    app = fastify();
    registerAuthRoutes(app, auth);
    registerAdminApi(app, {
      auth,
      db: handle.db,
      config,
      webScan: {
        store: new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey })),
        events,
      },
    });
    await seedAdminFixtures(handle.db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  const getSettings = async () =>
    app.inject({ method: 'GET', url: '/api/admin/web-scan/settings', headers: { cookie: adminCookie } });

  const patchSettings = async (payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload,
    });

  const getAudit = async () =>
    app.inject({ method: 'GET', url: '/api/admin/web-scan/audit', headers: { cookie: adminCookie } });

  it('GET returns the shipped global policy', async () => {
    const res = await getSettings();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paused).toBe(true);
    expect(body.alertsEnabled).toBe(false);
    expect(body.limits).toEqual({
      maxRequests: 500,
      maxPages: 100,
      maxActiveLinks: 30,
      requestsPerSecond: 2,
      requestTimeoutMs: 10000,
      maxResponseBytes: 1048576,
      totalTimeoutMs: 1200000,
    });
    expect(body.checks).toEqual({
      headers: true,
      cookies: true,
      transport: true,
      disclosure: true,
      files: true,
      active: false,
    });
    expect(body.defaultSchedule).toMatchObject({ frequency: 'weekly', enabled: false });
    expect(body.retentionDays).toBe(365);
    expect(body.approvedInstallations).toEqual([]);
    expect(body.updatedBy).toBeNull();
    expect(new Date(body.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('PATCH unpauses the scanner and audits exactly one settings change', async () => {
    const res = await patchSettings({ paused: false });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paused).toBe(false);
    expect(body.updatedBy).toBe('u-admin');

    const audit = await getAudit();
    expect(audit.statusCode).toBe(200);
    const rows = audit.json().audit;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      actor: 'u-admin',
      action: 'settings.update',
      targetType: 'settings',
    });
    expect(rows[0].before.paused).toBe(true);
    expect(rows[0].after.paused).toBe(false);
  });

  it('rejects unknown body keys with 422 and writes nothing, not even an audit row', async () => {
    const res = await patchSettings({ paused: false, schedule: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');

    const settings = await getSettings();
    expect(settings.json().paused).toBe(true);
    expect(settings.json().updatedBy).toBeNull();
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('refuses a body that writes the approved-installation list and writes nothing', async () => {
    const res = await patchSettings({
      approvedInstallations: [{ adminUserId: 'u-admin', installationId: 101, githubAccountId: 401 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');

    const settings = await getSettings();
    expect(settings.json().approvedInstallations).toEqual([]);
    expect(settings.json().updatedBy).toBeNull();
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('rejects unknown limit keys with 422', async () => {
    const res = await patchSettings({ limits: { maxRequests: 500, bogus: 7 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
  });

  it('rejects a limit above its ceiling with 422 before the store is called', async () => {
    const res = await patchSettings({ limits: { maxRequests: 2001 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');
    expect(res.json().error.message).toContain('ceiling');

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('rejects a limit below its minimum with 422', async () => {
    const res = await patchSettings({ limits: { requestsPerSecond: 0 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('minimum');

    const settings = await getSettings();
    expect(settings.json().limits.requestsPerSecond).toBe(2);
  });

  it('rejects an above-default limit without the confirmation and writes nothing', async () => {
    const res = await patchSettings({ limits: { maxRequests: 2000 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('confirmation_required');

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('accepts an above-default limit with the confirmation bound to the effective values', async () => {
    const digest = limitsConfirmationDigest({ ...DEFAULT_SCAN_LIMITS, maxRequests: 2000 });
    const res = await patchSettings({ limits: { maxRequests: 2000 }, limitConfirmation: { digest } });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits.maxRequests).toBe(2000);

    const audit = await getAudit();
    const rows = audit.json().audit;
    expect(rows.length).toBe(1);
    expect(rows[0].after.limits.maxRequests).toBe(2000);
  });

  it('a confirmation digest of different values does not confirm', async () => {
    const digest = limitsConfirmationDigest({ ...DEFAULT_SCAN_LIMITS, maxRequests: 1500 });
    const res = await patchSettings({ limits: { maxRequests: 2000 }, limitConfirmation: { digest } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('confirmation_required');

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
  });

  it('an out-of-range schedule hour is refused safely', async () => {
    const res = await patchSettings({
      defaultSchedule: { frequency: 'weekly', weekday: 5, hour: 25, minute: 0, enabled: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');

    const settings = await getSettings();
    expect(settings.json().defaultSchedule.hour).toBe(4);
  });

  it('a weekly schedule without its weekday is refused through the store mapping', async () => {
    const res = await patchSettings({
      defaultSchedule: { frequency: 'weekly', hour: 4, minute: 0, enabled: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');
    expect(res.json().error.message).toContain('weekday');

    const settings = await getSettings();
    expect(settings.json().defaultSchedule.enabled).toBe(false);
  });
});

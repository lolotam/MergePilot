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
import { WebScanConfirmationRequiredBodySchema } from '../api/contract-webscan.js';
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

  /** Builds the admin app over the given store. */
  const buildApp = async (webScanStore: PgWebScanStore): Promise<FastifyInstance> => {
    const auth: Auth = createAuth({ db: handle.db, config });
    const instance = fastify();
    registerAuthRoutes(instance, auth);
    registerAdminApi(instance, {
      auth,
      db: handle.db,
      config,
      webScan: {
        store: webScanStore,
        events,
      },
    });
    return instance;
  };

  beforeEach(async () => {
    handle = await createAdminTestDb();
    app = await buildApp(new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey })));
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

  it('refuses a patch that asks for nothing and writes nothing', async () => {
    const before = (await getSettings()).json();
    for (const payload of [{}, 'null']) {
      const res = await patchSettings(payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_request');
    }

    // A request without a body is a request error too.
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: adminCookie },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('invalid_request');

    const after = (await getSettings()).json();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.updatedBy).toBe(before.updatedBy);
    expect(after.paused).toBe(before.paused);
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('refuses a change that was computed from a snapshot the row moved away from', async () => {
    // A store whose settings move right after the route read them: the change is
    // computed from a snapshot that is not the current one any more.
    const racing = new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey }));
    const read = racing.getSettings.bind(racing);
    racing.getSettings = async () => {
      const snapshot = await read();
      await racing.updateSettings('admin-2', { contact: 'other@example.com' });
      return snapshot;
    };
    const racingApp = await buildApp(racing);
    await racingApp.ready();
    try {
      const res = await racingApp.inject({
        method: 'PATCH',
        url: '/api/admin/web-scan/settings',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        payload: { paused: false },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({
        code: 'conflict',
        message: 'The request conflicts with the current state',
      });
    } finally {
      await racingApp.close();
    }
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

  it('answers a missing confirmation with the digest and the fields above their default', async () => {
    const res = await patchSettings({ limits: { maxRequests: 2000, maxPages: 250 } });
    expect(res.statusCode).toBe(422);

    const body = WebScanConfirmationRequiredBodySchema.parse(res.json());
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.digest).toBe(
      limitsConfirmationDigest({ ...DEFAULT_SCAN_LIMITS, maxRequests: 2000, maxPages: 250 }),
    );
    expect(body.error.fieldsAboveDefault).toEqual(['maxRequests', 'maxPages']);

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
    expect(settings.json().limits.maxPages).toBe(100);
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('confirms the same patch with the digest of the answer and audits it once', async () => {
    const refused = await patchSettings({ limits: { maxRequests: 2000 } });
    expect(refused.statusCode).toBe(422);
    const answer = WebScanConfirmationRequiredBodySchema.parse(refused.json());

    const res = await patchSettings({
      limits: { maxRequests: 2000 },
      limitConfirmation: { digest: answer.error.digest },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits.maxRequests).toBe(2000);

    const audit = await getAudit();
    const rows = audit.json().audit;
    expect(rows.length).toBe(1);
    expect(rows[0].after.limits.maxRequests).toBe(2000);
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

  it('answers a wrong digest with the digest of the actual effective values', async () => {
    const other = limitsConfirmationDigest({ ...DEFAULT_SCAN_LIMITS, maxRequests: 1500 });
    const res = await patchSettings({
      limits: { maxRequests: 2000 },
      limitConfirmation: { digest: other },
    });
    expect(res.statusCode).toBe(422);

    const body = WebScanConfirmationRequiredBodySchema.parse(res.json());
    expect(body.error.digest).toBe(
      limitsConfirmationDigest({ ...DEFAULT_SCAN_LIMITS, maxRequests: 2000 }),
    );
    expect(body.error.digest).not.toBe(other);
    expect(body.error.fieldsAboveDefault).toEqual(['maxRequests']);

    const settings = await getSettings();
    expect(settings.json().limits.maxRequests).toBe(500);
    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(0);
  });

  it('accepts a limit within its default without any confirmation', async () => {
    const res = await patchSettings({ limits: { maxRequests: 400, maxPages: 50 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits.maxRequests).toBe(400);
    expect(res.json().limits.maxPages).toBe(50);

    const audit = await getAudit();
    expect(audit.json().audit.length).toBe(1);
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

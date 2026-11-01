import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import * as authSchema from '../auth/schema.js';
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

describe('web-scan route authorization (Task 8A)', () => {
  // `shadow@mergepilot.com` is listed as a platform admin but stays unverified, so the
  // guard must still deny it the same way it denies everyone else.
  const config = adminTestConfig(['admin@mergepilot.com', 'shadow@mergepilot.com']);
  const masterKey = randomBytes(32).toString('base64');
  const unknownSiteId = '11111111-1111-4111-8111-111111111111';

  const events: WebScanEventBus = {
    publish: () => {},
    subscribe: async () => () => {},
    close: async () => {},
  };

  const emptyScope = {
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };

  const createBody = () => ({
    hostname: 'example.com',
    baseUrl: 'https://example.com',
    scope: { crawlPaths: [{ path: '/', kind: 'prefix' }], ...emptyScope },
    authorize: true,
  });

  const siteUrl = `/api/admin/web-scan/sites/${unknownSiteId}`;

  // One attempt per Task 8A method. The unknown-route twin of each URL is the same
  // path with the `web-scan` segment misspelled, so both 404s come from the same
  // Fastify not-found handler.
  const attempts = [
    { label: 'GET settings', method: 'GET', url: '/api/admin/web-scan/settings' },
    { label: 'PATCH settings', method: 'PATCH', url: '/api/admin/web-scan/settings', payload: {} },
    { label: 'GET sites', method: 'GET', url: '/api/admin/web-scan/sites' },
    { label: 'POST sites', method: 'POST', url: '/api/admin/web-scan/sites', payload: createBody() },
    { label: 'GET site', method: 'GET', url: siteUrl },
    { label: 'PATCH site', method: 'PATCH', url: siteUrl, payload: { repositoryId: 'r-1' } },
    { label: 'DELETE site', method: 'DELETE', url: siteUrl },
    { label: 'GET audit', method: 'GET', url: '/api/admin/web-scan/audit' },
  ] as const;

  const unknownTwin = (url: string): string => url.replace('/web-scan/', '/web-scanx/');

  const inject = (method: string, url: string, cookie?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

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

    // Unverified user whose email IS in the platform-admins list.
    await handle.db.insert(authSchema.user).values({
      id: 'u-unverified',
      name: 'Unverified Operator',
      email: 'shadow@mergepilot.com',
      emailVerified: false,
    });
    await handle.db.insert(authSchema.session).values({
      id: 's-unverified',
      token: fixtureToken('unverified'),
      userId: 'u-unverified',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // Verified user who administers their own workspace but is not a platform admin.
    await handle.db.insert(authSchema.user).values({
      id: 'u-other',
      name: 'Other Workspace Owner',
      email: 'other@example.com',
      emailVerified: true,
    });
    await handle.db.insert(authSchema.session).values({
      id: 's-other',
      token: fixtureToken('other'),
      userId: 'u-other',
      expiresAt: new Date(Date.now() + 86400000),
    });
    await handle.db.insert(authSchema.organization).values({ id: 'ws-3', name: 'Third Org', slug: 'third-org' });
    await handle.db.insert(authSchema.member).values({
      id: 'm-3',
      organizationId: 'ws-3',
      userId: 'u-other',
      role: 'owner',
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  const cookies = {
    unauthenticated: undefined,
    unverified: signedSessionCookie(fixtureToken('unverified'), config.authSecret),
    workspaceAdmin: signedSessionCookie(fixtureToken('regular'), config.authSecret),
    otherWorkspace: signedSessionCookie(fixtureToken('other'), config.authSecret),
  };

  for (const [role, cookie] of Object.entries(cookies)) {
    for (const attempt of attempts) {
      it(`${role} ${attempt.label} is the same 404 as an unknown route`, async () => {
        const denied = await inject(attempt.method, attempt.url, cookie, attempt.payload);
        const unknown = await inject(attempt.method, unknownTwin(attempt.url), cookie, attempt.payload);
        expect(denied.statusCode).toBe(404);
        expect(denied.statusCode).toBe(unknown.statusCode);
        expect(Object.keys(denied.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
        expect(denied.body).not.toContain('adminUser');
      });
    }
  }

  it('a signed-out PATCH settings attempt writes nothing', async () => {
    await inject('PATCH', '/api/admin/web-scan/settings', undefined, { enabled: true });
    const audit = await inject('GET', '/api/admin/web-scan/audit', signedSessionCookie(fixtureToken('admin'), config.authSecret));
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audit).toEqual([]);
  });

  it('the platform admin still reaches every read route', async () => {
    const adminCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
    const created = await inject('POST', '/api/admin/web-scan/sites', adminCookie, createBody());
    expect(created.statusCode).toBe(201);
    const siteId = (created.json() as { id: string }).id;

    const reads = [
      { label: 'GET settings', url: '/api/admin/web-scan/settings' },
      { label: 'GET sites', url: '/api/admin/web-scan/sites' },
      { label: 'GET site', url: `/api/admin/web-scan/sites/${siteId}` },
      { label: 'GET audit', url: '/api/admin/web-scan/audit' },
    ];
    for (const read of reads) {
      const res = await inject('GET', read.url, adminCookie);
      expect(res.statusCode, `${read.label} -> ${res.body}`).toBe(200);
    }
  });
});

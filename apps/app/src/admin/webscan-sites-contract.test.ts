import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { WebScanCreateSiteSchema } from '../api/contract-webscan-site.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

/**
 * The contract of the sites of the scanner (ADR-0052 sections 1 and 6).
 *
 * A registration names the host the scanner starts at, so the base URL has to name
 * the hostname of the site and to use its default port. A change that asks for
 * nothing is refused, because it would write a change and an audit row for a
 * request that asked for nothing.
 */

describe('the web-scan site contract (Task 8A)', () => {
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
    const auth = createAuth({ db: handle.db, config });
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

  const emptyScope = {
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };

  const createBody = (hostname = 'example.com') => ({
    hostname,
    baseUrl: `https://${hostname}`,
    scope: { ...emptyScope },
    authorize: true,
  });

  const createSite = async (hostname = 'example.com') =>
    app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: createBody(hostname),
    });

  const getSite = async (siteId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie },
    });

  const patchSite = async (payload: Record<string, unknown> | string, siteId: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload,
    });

  const auditActions = async (): Promise<string[]> => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/audit',
      headers: { cookie: adminCookie },
    });
    // Rows written in one transaction share a timestamp, so their order is not part of
    // what these tests check: the set of actions is.
    return res
      .json()
      .audit.map((row: { action: string }) => row.action)
      .sort();
  };

  it('a patch that asks for nothing is refused and changes nothing', async () => {
    const created = await createSite();
    const siteId = created.json().id as string;
    const before = (await getSite(siteId)).json();

    for (const payload of [{}, 'null']) {
      const refused = await patchSite(payload, siteId);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.code).toBe('invalid_request');
    }

    // A request without a body is a request error too.
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie },
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('invalid_request');

    // The confirmation alone is not a change: it only confirms the change that
    // carries it.
    const confirmedOnly = await patchSite({ authorize: true }, siteId);
    expect(confirmedOnly.statusCode).toBe(422);
    expect(confirmedOnly.json().error.code).toBe('invalid_request');

    const after = (await getSite(siteId)).json();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.authorization.scopeVersion).toBe(before.authorization.scopeVersion);
    expect(await auditActions()).toEqual(['site.authorize', 'site.create']);
  });

  it('the base URL has to name the hostname of the site', async () => {
    const matching = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('same.example.com'), baseUrl: 'https://same.example.com' },
    });
    expect(matching.statusCode).toBe(201);

    // A path inside the site is allowed: the scanner may start from it.
    const withPath = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('app.example.com'), baseUrl: 'https://app.example.com/app' },
    });
    expect(withPath.statusCode).toBe(201);
    expect(withPath.json().baseUrl).toBe('https://app.example.com/app');

    const otherHost = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('named.example.com'), baseUrl: 'https://other.example.com' },
    });
    expect(otherHost.statusCode).toBe(422);
    expect(otherHost.json().error.code).toBe('invalid_request');

    // A host that is not the hostname of the site is refused, and so is a path that
    // only looks like one.
    const lookalike = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('example.com'), baseUrl: 'https://evil.test/deep/path' },
    });
    expect(lookalike.statusCode).toBe(422);

    // Another port is another service of the same host.
    const otherPort = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('ported.example.com'), baseUrl: 'https://ported.example.com:8443' },
    });
    expect(otherPort.statusCode).toBe(422);

    // The issue names the field that has to change.
    const issue = WebScanCreateSiteSchema.safeParse({
      ...createBody('named.example.com'),
      baseUrl: 'https://other.example.com',
    });
    expect(issue.success).toBe(false);
    expect(issue.error?.issues[0]?.path).toEqual(['baseUrl']);
  });
});

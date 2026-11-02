import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import * as authSchema from '../auth/schema.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { webScanSettings, webScanSites } from '../db/schema.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { registerAdminApi } from './routes.js';
import {
  TARGET_ACCOUNT_ID,
  TARGET_INSTALLATION_ID,
  aTargetVerifier,
} from './webscan-target.fixtures.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

/**
 * The owner of a site and its repository binding (ADR-0052 section 8).
 *
 * The alerts of a site are delivered as the administrator that owns it, so the
 * binding of a repository has to be backed by that administrator. Another
 * platform administrator may unlink the repository, because an unlink removes a
 * target and never adds one.
 *
 * The GitHub boundary is a fake, so no test ever reaches GitHub, and the
 * database is the real one.
 */

describe('the owner of the repository of a site', () => {
  const config = adminTestConfig(['admin@mergepilot.com', 'operator@mergepilot.com']);
  const ownerCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
  const otherCookie = signedSessionCookie(fixtureToken('operator'), config.authSecret);
  const masterKey = randomBytes(32).toString('base64');

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

  let app: FastifyInstance;
  let handle: AdminTestDb;
  let store: PgWebScanStore;

  beforeAll(async () => {
    handle = await createAdminTestDb();
    const auth: Auth = createAuth({ db: handle.db, config });
    app = fastify();
    registerAuthRoutes(app, auth);
    store = new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey }));
    registerAdminApi(app, {
      auth,
      db: handle.db,
      config,
      webScan: { store, events, github: aTargetVerifier() },
    });
    await seedAdminFixtures(handle.db);

    // A second platform administrator: verified, in the admin list, and not
    // the owner of the sites of the first one.
    await handle.db.insert(authSchema.user).values({
      id: 'u-operator',
      name: 'Second Operator',
      email: 'operator@mergepilot.com',
      emailVerified: true,
    });
    await handle.db.insert(authSchema.session).values({
      id: 's-operator',
      token: fixtureToken('operator'),
      userId: 'u-operator',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date('2026-10-12T10:00:00.000Z'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  beforeEach(async () => {
    // The sites and the approval of the previous test are gone, so every test
    // starts from an empty list.
    await handle.db.delete(webScanSites);
    await handle.db
      .update(webScanSettings)
      .set({ approvedInstallations: [], updatedBy: null });
  });

  /** The owner approves the installation the alerts would be delivered through. */
  const approve = async () => {
    await store.approveInstallation('u-admin', {
      adminUserId: 'u-admin',
      installationId: TARGET_INSTALLATION_ID,
      githubAccountId: TARGET_ACCOUNT_ID,
    });
  };

  const createSite = async () =>
    app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: {
        hostname: 'example.com',
        baseUrl: 'https://example.com',
        scope: { ...emptyScope, crawlPaths: [{ path: '/', kind: 'prefix' }] },
        authorize: true,
      },
    });

  const patchSite = async (cookie: string, payload: Record<string, unknown> | string, siteId: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload,
    });

  const getSite = async (siteId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: ownerCookie },
    });

  const auditTotal = async (): Promise<number> => {
    const audit = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/audit?limit=100',
      headers: { cookie: ownerCookie },
    });
    return audit.json().total as number;
  };

  it('the owner of the site binds its repository', async () => {
    await approve();
    const created = await createSite();
    expect(created.statusCode).toBe(201);
    const siteId = created.json().id as string;

    const bound = await patchSite(
      ownerCookie,
      { repository: { owner: 'acme', name: 'demo' } },
      siteId,
    );
    expect(bound.statusCode).toBe(200);
    expect(bound.json().repository).toMatchObject({ owner: 'acme', name: 'demo' });
  });

  it('another administrator cannot bind a repository to the site of somebody else', async () => {
    await approve();
    const created = await createSite();
    const siteId = created.json().id as string;
    const bound = await patchSite(
      ownerCookie,
      { repository: { owner: 'acme', name: 'demo' } },
      siteId,
    );
    expect(bound.statusCode).toBe(200);

    const auditBefore = await auditTotal();
    // The log holds the rows of the creation and of the binding, so a refusal
    // that writes nothing keeps its number.
    expect(auditBefore).toBeGreaterThan(0);
    const refused = await patchSite(
      otherCookie,
      { repository: { owner: 'acme', name: 'other' } },
      siteId,
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toEqual({
      code: 'target_refused',
      reason: 'not_site_owner',
      message: 'Only the owner of the site can bind its repository',
    });

    // Nothing was written: the binding of the owner is still there and the
    // refused request left no audit row behind.
    expect((await getSite(siteId)).json().repository).toMatchObject({ name: 'demo' });
    expect(await auditTotal()).toBe(auditBefore);
  });

  it('another administrator may unlink the repository of the site', async () => {
    await approve();
    const created = await createSite();
    const siteId = created.json().id as string;
    const bound = await patchSite(
      ownerCookie,
      { repository: { owner: 'acme', name: 'demo' } },
      siteId,
    );
    expect(bound.statusCode).toBe(200);

    const unlinked = await patchSite(otherCookie, { repository: null }, siteId);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().repository).toBeNull();
    expect((await getSite(siteId)).json().repository).toBeNull();
  });
});

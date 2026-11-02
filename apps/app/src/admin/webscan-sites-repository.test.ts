import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { webScanSettings, webScanSites } from '../db/schema.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import type { WebScanGitHubVerifier } from '../webscan/github-target.js';
import type { WebScanGitHubTargetReason } from '../webscan/github-target-reasons.js';
import { registerAdminApi } from './routes.js';
import {
  TARGET_ACCOUNT_ID,
  TARGET_INSTALLATION_ID,
  TARGET_REPOSITORY_ID,
  aTargetBinding,
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
 * The tests of the repository of a site (ADR-0052 section 8).
 *
 * The repository of a site is server-derived: the request names it and the
 * server asks GitHub for its ids. The GitHub boundary is a fake, so no test ever
 * reaches GitHub, and the database is the real one.
 *
 * The database is shared by the tests of this file: the sites are removed
 * between them, and the audit log is append-only, so every test counts the rows
 * it wrote itself.
 */

const INSTALLATION_ID = TARGET_INSTALLATION_ID;
const ACCOUNT_ID = TARGET_ACCOUNT_ID;
const REPOSITORY_ID = TARGET_REPOSITORY_ID;

/** The app, the database and the store of one test. */
interface SiteHarness {
  app: FastifyInstance;
  handle: AdminTestDb;
  store: PgWebScanStore;
}

describe('the repository of a site', () => {
  const config = adminTestConfig(['admin@mergepilot.com']);
  const adminCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
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

  let harness: SiteHarness;
  /** The refusal the fake answers with; undefined means the happy path. */
  let refusal: { ok: false; reason: WebScanGitHubTargetReason } | undefined;

  /** Builds an app with the GitHub boundary the test needs. */
  const buildHarness = async (github?: WebScanGitHubVerifier): Promise<SiteHarness> => {
    const handle = await createAdminTestDb();
    const auth: Auth = createAuth({ db: handle.db, config });
    const app = fastify();
    registerAuthRoutes(app, auth);
    const store = new PgWebScanStore(handle.db, new PurposeScopedVault({ masterKey }));
    registerAdminApi(app, {
      auth,
      db: handle.db,
      config,
      webScan: { store, events, github },
    });
    await seedAdminFixtures(handle.db);
    await app.ready();
    return { app, handle, store };
  };

  beforeAll(async () => {
    harness = await buildHarness(
      aTargetVerifier({
        verifyRepository: async ({ owner, name }) =>
          refusal ?? { ok: true, binding: aTargetBinding(owner, name) },
      }),
    );
  });

  beforeEach(async () => {
    refusal = undefined;
    // The sites and the approval of the previous test are gone, so every test
    // starts from an empty list.
    await harness.handle.db.delete(webScanSites);
    await harness.handle.db
      .update(webScanSettings)
      .set({ approvedInstallations: [], updatedBy: null });
  });

  const approve = async () => {
    await harness.store.approveInstallation('u-admin', {
      adminUserId: 'u-admin',
      installationId: INSTALLATION_ID,
      githubAccountId: ACCOUNT_ID,
    });
  };

  const createSite = async (payload: Record<string, unknown> = {}) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname: 'example.com',
        baseUrl: 'https://example.com',
        scope: { ...emptyScope, crawlPaths: [{ path: '/', kind: 'prefix' }] },
        authorize: true,
        ...payload,
      },
    });

  const patchSite = async (payload: unknown, siteId: string) =>
    harness.app.inject({
      method: 'PATCH',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload,
    });

  const getSite = async (siteId: string) =>
    harness.app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie },
    });

  const getAudit = async () =>
    harness.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/audit',
      headers: { cookie: adminCookie },
    });

  it('stores the ids GitHub reported and not the ones of the request', async () => {
    await approve();
    const created = await createSite({ repository: { owner: 'acme', name: 'demo' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().repository).toEqual({
      owner: 'acme',
      name: 'demo',
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      githubAccountId: ACCOUNT_ID,
    });
  });

  it('refuses a body that tries to set the ids itself', async () => {
    await approve();
    const refused = await createSite({
      repository: {
        owner: 'acme',
        name: 'demo',
        repositoryId: 999,
        installationId: 999,
        githubAccountId: 999,
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('invalid_request');

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie },
    });
    expect(listed.json().total).toBe(0);
  });

  it('refuses a repository without an approved installation', async () => {
    const refused = await createSite({ repository: { owner: 'acme', name: 'demo' } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toEqual({
      code: 'target_refused',
      reason: 'repository_not_approved',
      message: 'No approved installation of the administrator owns the repository',
    });

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie },
    });
    expect(listed.json().total).toBe(0);
  });

  it('refuses a public repository', async () => {
    await approve();
    refusal = { ok: false, reason: 'not_private' };
    const refused = await createSite({ repository: { owner: 'acme', name: 'demo' } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe('not_private');
  });

  it('refuses a repository of another account', async () => {
    await approve();
    refusal = { ok: false, reason: 'account_mismatch' };
    const refused = await createSite({ repository: { owner: 'acme', name: 'demo' } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.reason).toBe('account_mismatch');
  });

  it('refuses a request when GitHub is not available at all', async () => {
    const withoutGitHub = await buildHarness(undefined);
    try {
      await withoutGitHub.store.approveInstallation('u-admin', {
        adminUserId: 'u-admin',
        installationId: INSTALLATION_ID,
        githubAccountId: ACCOUNT_ID,
      });
      const refused = await withoutGitHub.app.inject({
        method: 'POST',
        url: '/api/admin/web-scan/sites',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        payload: {
          hostname: 'example.com',
          baseUrl: 'https://example.com',
          scope: { ...emptyScope },
          authorize: true,
          repository: { owner: 'acme', name: 'demo' },
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.reason).toBe('github_unavailable');
    } finally {
      await withoutGitHub.app.close();
      await withoutGitHub.handle.close();
    }
  });

  it('a repository change alone does not need the authorization confirmation', async () => {
    await approve();
    const created = await createSite();
    const siteId = created.json().id as string;
    const patched = await patchSite({ repository: { owner: 'acme', name: 'demo' } }, siteId);
    expect(patched.statusCode).toBe(200);
    expect(patched.json().repository).toMatchObject({ repositoryId: REPOSITORY_ID });
  });

  it('a null repository unlinks the site and an absent one keeps the link', async () => {
    await approve();
    const created = await createSite();
    const siteId = created.json().id as string;
    const linked = await patchSite({ repository: { owner: 'acme', name: 'demo' } }, siteId);
    expect(linked.statusCode).toBe(200);
    expect(linked.json().repository).toMatchObject({ repositoryId: REPOSITORY_ID, name: 'demo' });

    // A patch that carries no repository field leaves the link alone.
    const untouched = await patchSite({ scope: { ...emptyScope }, authorize: true }, siteId);
    expect(untouched.statusCode).toBe(200);
    expect(untouched.json().repository).toMatchObject({ repositoryId: REPOSITORY_ID });

    // A null repository unlinks the site.
    const unlinked = await patchSite({ repository: null, authorize: true }, siteId);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.json().repository).toBeNull();
    expect((await getSite(siteId)).json().repository).toBeNull();

    // The audit log shows the update and the repository it removed.
    const audit = (await getAudit()).json().audit as Array<{
      action: string;
      targetId: string;
      before: { repository: unknown };
      after: { repository: unknown };
    }>;
    const updates = audit.filter((row) => row.action === 'site.update' && row.targetId === siteId);
    const unlinkedUpdate = updates.find((row) => row.after.repository === null);
    expect(unlinkedUpdate?.before.repository).toMatchObject({ repositoryId: REPOSITORY_ID });
    expect(unlinkedUpdate?.after.repository).toBeNull();

    // A new repository replaces the old binding.
    const relinked = await patchSite({ repository: { owner: 'acme', name: 'other' } }, siteId);
    expect(relinked.statusCode).toBe(200);
    expect(relinked.json().repository).toMatchObject({ owner: 'acme', name: 'other' });
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ScanSettingsError } from '@mergepilot/webscan';
import { createAuth, type Auth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { WebScanAuthorizationError, WebScanPausedError } from '../webscan/store.js';
import { sendWebScanError } from './webscan-http.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

describe('web-scan site routes (Task 8A)', () => {
  const config = adminTestConfig(['admin@mergepilot.com']);
  const adminCookie = signedSessionCookie(fixtureToken('admin'), config.authSecret);
  const masterKey = randomBytes(32).toString('base64');

  const events: WebScanEventBus = {
    publish: () => {},
    subscribe: async () => () => {},
    close: async () => {},
  };

  const unknownSiteId = '11111111-1111-4111-8111-111111111111';

  let app: FastifyInstance;
  let handle: AdminTestDb;

  beforeEach(async () => {
    handle = await createAdminTestDb();
    const auth: Auth = createAuth({ db: handle.db, config });
    app = fastify();
    registerAuthRoutes(app, auth);

    // A synthetic route that throws each scanner error class directly, so the
    // mapping of every class is checkable even where no Task 8A route raises it.
    app.get('/api/admin/web-scan/error-test', {}, async (request, reply) => {
      const kind = (request.query as { kind?: string }).kind;
      const error =
        kind === 'paused'
          ? new WebScanPausedError()
          : kind === 'authorization_required'
            ? new WebScanAuthorizationError('The site is not authorized')
            : new ScanSettingsError('below_minimum', 'maxRequests is below its minimum.', 'maxRequests');
      return sendWebScanError(reply, error) ?? reply.status(500).send();
    });

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
    scope: { ...emptyScope, crawlPaths: [{ path: '/', kind: 'prefix' }] },
    authorize: true,
  });

  const createSite = async (hostname?: string) =>
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

  const patchSite = async (payload: unknown, siteId = unknownSiteId) =>
    app.inject({
      method: 'PATCH',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload,
    });

  const getAudit = async () =>
    app.inject({ method: 'GET', url: '/api/admin/web-scan/audit', headers: { cookie: adminCookie } });

  const auditActions = async () => (await getAudit()).json().audit.map((row: { action: string }) => row.action);

  it('a platform admin registers, reads, changes and removes a site', async () => {
    const created = await createSite();
    expect(created.statusCode).toBe(201);
    const site = created.json();
    expect(site.hostname).toBe('example.com');
    expect(site.baseUrl).toBe('https://example.com');
    expect(site.ownerUserId).toBe('u-admin');
    expect(site.authorization.scopeVersion).toBe(1);
    expect(site.removedAt).toBeNull();
    expect(site.scope.crawlPaths).toEqual([{ path: '/', kind: 'prefix' }]);

    const read = await getSite(site.id);
    expect(read.statusCode).toBe(200);
    expect(read.json().id).toBe(site.id);

    const patched = await patchSite(
      { scope: { ...emptyScope }, schedule: { frequency: 'daily', hour: 3, minute: 30, enabled: true }, authorize: true },
      site.id,
    );
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json();
    expect(patchedBody.schedule).toMatchObject({ frequency: 'daily', hour: 3, enabled: true });
    expect(patchedBody.authorization.scopeVersion).toBe(2);

    // The fresh authorization and the change each carried their own audit row
    // (the store writes the update first, then the authorization), and no scan
    // was queued, so no stopped-queued-scan row exists either.
    expect(await auditActions()).toEqual([
      'site.authorize',
      'site.update',
      'site.authorize',
      'site.create',
    ]);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${site.id}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removedAt).toEqual(expect.any(String));

    // The removal is soft: the row answers with its removed state and the
    // list no longer shows it.
    const afterRemoval = await getSite(site.id);
    expect(afterRemoval.statusCode).toBe(200);
    expect(afterRemoval.json().removedAt).toEqual(expect.any(String));
    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie },
    });
    expect(listed.json().total).toBe(0);
  });

  it('the audit log shows exactly the actions of each mutation', async () => {
    expect((await auditActions()).length).toBe(0);
    const created = await createSite();
    expect(await auditActions()).toEqual(['site.authorize', 'site.create']);
    const siteId = created.json().id as string;
    await patchSite({ repository: { owner: 'acme', name: 'demo', repositoryId: 7, installationId: 101, githubAccountId: 401 } }, siteId);
    expect(await auditActions()).toEqual(['site.update', 'site.authorize', 'site.create']);

    await app.inject({
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${siteId}`,
      headers: { cookie: adminCookie },
    });
    expect(await auditActions()).toEqual(['site.remove', 'site.update', 'site.authorize', 'site.create']);
  });

  it('GET sites paginates with limit and offset', async () => {
    await createSite('a.example.com');
    await createSite('b.example.com');

    const full = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie },
    });
    expect(full.json().total).toBe(2);
    expect(full.json().sites.length).toBe(2);
    expect(full.json().limit).toBe(50);

    const page = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites?limit=1&offset=1',
      headers: { cookie: adminCookie },
    });
    expect(page.json().sites.length).toBe(1);
    expect(page.json().total).toBe(2);
  });

  it('a duplicate hostname and an unknown site map to their store errors', async () => {
    await createSite();
    const duplicate = await createSite();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toEqual({
      code: 'conflict',
      message: 'The request conflicts with the current state',
    });

    const missing = await getSite(unknownSiteId);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'not_found', message: 'Not found' });
  });

  it('every store error class maps to its status and a fixed safe body', async () => {
    const paused = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/error-test?kind=paused',
      headers: { cookie: adminCookie },
    });
    expect(paused.statusCode).toBe(409);
    expect(paused.json().error.code).toBe('paused');

    const authorization = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/error-test?kind=authorization_required',
      headers: { cookie: adminCookie },
    });
    expect(authorization.statusCode).toBe(409);
    expect(authorization.json().error.code).toBe('authorization_required');
    expect(authorization.json().error.message).not.toContain('not authorized to be scanned is wrong');
  });

  it('a registration without the authorization confirmation is refused and writes nothing', async () => {
    const { authorize: _authorize, ...body } = createBody();
    const refused = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: body,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('invalid_request');
    expect(refused.json().error.message).toBe('A registration needs an explicit authorization confirmation');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie },
    });
    expect(listed.json().total).toBe(0);
    expect(await auditActions()).toEqual([]);
  });

  it('a scope change without authorize is refused and changes nothing', async () => {
    const created = await createSite();
    const siteId = created.json().id as string;

    const refused = await patchSite({ scope: { ...emptyScope } }, siteId);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('confirmation_required');

    const unchanged = await getSite(siteId);
    expect(unchanged.json().authorization.scopeVersion).toBe(1);
    expect(await auditActions()).toEqual(['site.authorize', 'site.create']);
  });

  it('a repository change alone does not need the authorization confirmation', async () => {
    const created = await createSite();
    const siteId = created.json().id as string;
    const patched = await patchSite(
      { repository: { owner: 'acme', name: 'demo', repositoryId: 7, installationId: 101, githubAccountId: 401 } },
      siteId,
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().repository).toMatchObject({ repositoryId: 7 });
    expect(await auditActions()).toEqual(['site.update', 'site.authorize', 'site.create']);
  });

  it('strict schemas reject unknown keys, bad hostnames and bad ids with 422', async () => {
    const unknownKey = await createSite();
    expect(unknownKey.statusCode).toBe(201);
    const extra = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('extra.example.com'), ownerUserId: 'u-regular' },
    });
    expect(extra.statusCode).toBe(422);
    expect(extra.json().error.code).toBe('invalid_request');

    const badHostname = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: createBody('https://example.com'),
    });
    expect(badHostname.statusCode).toBe(422);

    const badBaseUrl = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { ...createBody('clean.example.com'), baseUrl: 'https://example.com/?code=auth' },
    });
    expect(badBaseUrl.statusCode).toBe(422);

    const badId = await getSite('not-a-uuid');
    expect(badId.statusCode).toBe(422);
    expect(badId.json().error.code).toBe('invalid_request');
  });

  it('bad pagination values are answered 422', async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'bogus=1']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/web-scan/sites?${query}`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_request');
    }
  });

  it('no secret-looking field reaches a serialized site or settings response', async () => {
    const created = await createSite();
    const site = await getSite(created.json().id as string);
    const settings = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: adminCookie },
    });
    for (const raw of [site.body, settings.body]) {
      for (const marker of [
        'identityKey',
        'identitykeyciphertext',
        'ciphertext',
        'plaintext',
        'seal',
        'secret',
        'vault:',
        'lease',
        'heartbeat',
      ]) {
        expect(raw.toLowerCase().includes(marker)).toBe(false);
      }
    }
  });
});

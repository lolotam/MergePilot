import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAuth, type Auth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { PgStore } from '../db/pg-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from '../credentials/service.js';
import type { AppConfig } from '../core/config.js';
import { registerDashboardApi } from './routes.js';

describe('dashboard api - auth and github routes (me, installations, link)', () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let vault: EnvelopeVault;
  let credentials: CredentialService;
  let auth: Auth;
  const mockFetch = vi.fn();

  const config: AppConfig = {
    baseUrl: 'http://localhost:3000',
    port: 3000,
    databaseUrl: 'postgres://localhost:5432/test',
    redisUrl: 'redis://localhost:6379',
    masterKey: '01234567890123456789012345678901',
    github: {
      appId: '12345',
      privateKey: 'key',
      webhookSecret: 'secret',
      clientId: 'gh-id',
      clientSecret: 'gh-secret',
      appSlug: 'mergepilot-app',
    },
    google: { clientId: 'g-id', clientSecret: 'g-secret' },
    authSecret: 'sk-test-secret-32-chars-long-0000000',
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    pglite = new PGlite();
    const appSql = readFileSync(join(__dirname, '../../migrations/0001_app.sql'), 'utf-8');
    const authSql = readFileSync(join(__dirname, '../../migrations/0002_auth.sql'), 'utf-8');
    await pglite.exec(appSql);
    await pglite.exec(authSql);

    const schema = { ...authSchema, ...dbSchema };
    db = drizzle(pglite, { schema });
    store = new PgStore(db);
    vault = new EnvelopeVault(Buffer.alloc(32, 1).toString('base64'));
    credentials = new CredentialService({ store, vault });
    auth = createAuth({ db, config });

    app = fastify();
    registerAuthRoutes(app, auth);
    registerDashboardApi(app, {
      auth,
      store,
      credentials,
      config,
      githubFetch: mockFetch as unknown as typeof fetch,
    });

    // Seed users
    // User 1: member, no github account
    await db.insert(authSchema.user).values([
      { id: 'u-member', name: 'Member User', email: 'member@test.com', emailVerified: true },
      { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
      { id: 'u-outsider', name: 'Outsider User', email: 'outsider@test.com', emailVerified: true },
    ]);

    await db.insert(authSchema.session).values([
      { id: 's-member', token: 'token-member', userId: 'u-member', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-admin', token: 'token-admin', userId: 'u-admin', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-outsider', token: 'token-outsider', userId: 'u-outsider', expiresAt: new Date(Date.now() + 86400000) },
    ]);

    // Admin has GitHub account linked
    await db.insert(authSchema.account).values({
      id: 'acc-admin-gh',
      accountId: 'gh-123456',
      providerId: 'github',
      userId: 'u-admin',
      accessToken: 'gho_secret_admin_token_123',
    });

    // Workspaces
    await db.insert(authSchema.organization).values([
      { id: 'ws-A', name: 'Workspace A', slug: 'workspace-a' },
      { id: 'ws-B', name: 'Workspace B', slug: 'workspace-b' },
    ]);

    // Memberships: ws-A has u-member (member) and u-admin (admin). ws-B has u-outsider (member).
    // u-admin is also member of ws-B
    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: 'ws-A', userId: 'u-member', role: 'member' },
      { id: 'm-2', organizationId: 'ws-A', userId: 'u-admin', role: 'admin' },
      { id: 'm-3', organizationId: 'ws-B', userId: 'u-outsider', role: 'member' },
      { id: 'm-4', organizationId: 'ws-B', userId: 'u-admin', role: 'member' },
    ]);

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  it('GET /api/me requires session and returns user and workspaces with role and githubLinked', async () => {
    // 401 when unauthenticated
    const res401 = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res401.statusCode).toBe(401);

    // Member with no github link
    const resMember = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(resMember.statusCode).toBe(200);
    const bodyMember = resMember.json();
    expect(bodyMember.user).toEqual({
      id: 'u-member',
      email: 'member@test.com',
      name: 'Member User',
      image: null,
      githubLinked: false,
    });
    expect(bodyMember.workspaces).toHaveLength(1);
    expect(bodyMember.workspaces[0]).toEqual({
      id: 'ws-A',
      name: 'Workspace A',
      slug: 'workspace-a',
      role: 'member',
    });

    // Admin with github link and multiple workspaces
    const resAdmin = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resAdmin.statusCode).toBe(200);
    const bodyAdmin = resAdmin.json();
    expect(bodyAdmin.user.githubLinked).toBe(true);
    expect(bodyAdmin.workspaces).toHaveLength(2);
    const rolesMap = Object.fromEntries(bodyAdmin.workspaces.map((w: { id: string; role: string }) => [w.id, w.role]));
    expect(rolesMap['ws-A']).toBe('admin');
    expect(rolesMap['ws-B']).toBe('member');
  });

  it('GET /api/workspaces/:workspaceId/installations lists installations', async () => {
    // Seed installations for ws-A
    await store.upsertInstallation({
      id: 501,
      workspaceId: 'ws-A',
      accountLogin: 'acme-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/installations',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.installations).toEqual([
      {
        id: 501,
        accountLogin: 'acme-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      },
    ]);
  });

  it('POST /api/workspaces/:workspaceId/installations/:installationId/link enforces permissions and conflicts', async () => {
    // 1. Member cannot link (admin required -> 403)
    const resMember = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/501/link',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(resMember.statusCode).toBe(403);

    // 2. Outsider cannot link (403)
    const resOutsider = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/501/link',
      headers: { cookie: signedSessionCookie('token-outsider', config.authSecret) },
    });
    expect(resOutsider.statusCode).toBe(403);

    // Mock GitHub user installations: admin has access to 501, 502, 503
    mockFetch.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/user/installations')) {
        return new Response(
          JSON.stringify({
            total_count: 3,
            installations: [
              { id: 501 },
              { id: 502 },
              { id: 503 },
              {
                id: 504,
                account: { login: 'lolotam', type: 'User' },
                repository_selection: 'selected',
                suspended_at: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    // 3. User cannot access installation 999 (not in user installation list -> 403)
    const resNotAccessible = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/999/link',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resNotAccessible.statusCode).toBe(403);

    // 4. Installation 502 is linked to another workspace (ws-B) -> 409
    await store.upsertInstallation({
      id: 502,
      workspaceId: 'ws-B',
      accountLogin: 'other-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });
    const resConflict = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/502/link',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resConflict.statusCode).toBe(409);

    // 5. Installation 503 is pending (unlinked) -> 204 success
    await store.upsertPendingInstallation({
      id: 503,
      accountLogin: 'pending-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });
    const resSuccess = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/503/link',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resSuccess.statusCode).toBe(204);

    // Verify installation 503 is now linked to ws-A
    const linked = await store.getInstallation(503);
    expect(linked?.workspaceId).toBe('ws-A');

    // 6. Linking already linked to the same workspace -> 204 success
    const resSameLink = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/503/link',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resSameLink.statusCode).toBe(204);

    // 7. Installation 504 never arrived by webhook but GitHub confirms it to the user -> recorded and linked
    expect(await store.getInstallation(504)).toBeNull();
    const resNoWebhook = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-A/installations/504/link',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resNoWebhook.statusCode).toBe(204);
    expect(await store.getInstallation(504)).toMatchObject({
      workspaceId: 'ws-A',
      accountLogin: 'lolotam',
      accountType: 'User',
      repositorySelection: 'selected',
      suspended: false,
    });
  });

  it('GET /api/github/installations returns 409 github_not_linked or lists installations with linkedWorkspaceId and installUrl', async () => {
    // 1. Unauthenticated -> 401
    const res401 = await app.inject({ method: 'GET', url: '/api/github/installations' });
    expect(res401.statusCode).toBe(401);

    // 2. Member without GitHub linked -> 409 github_not_linked
    const resNotLinked = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(resNotLinked.statusCode).toBe(409);
    expect(resNotLinked.json().error.code).toBe('github_not_linked');

    // 3. Admin with GitHub linked -> 200
    // Mock GitHub user installations returning 2 installations
    mockFetch.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/user/installations')) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            installations: [
              {
                id: 601,
                account: { login: 'octocat', type: 'User' },
                repository_selection: 'all',
                suspended_at: null,
              },
              {
                id: 602,
                account: { login: 'github-corp', type: 'Organization' },
                repository_selection: 'selected',
                suspended_at: '2026-01-01T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    // Seed installation 601 linked to ws-A in store; 602 is unlinked
    await store.upsertInstallation({
      id: 601,
      workspaceId: 'ws-A',
      accountLogin: 'octocat',
      accountType: 'User',
      repositorySelection: 'all',
      suspended: false,
    });

    const resAdmin = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(resAdmin.statusCode).toBe(200);
    const body = resAdmin.json();
    expect(body.installUrl).toBe('https://github.com/apps/mergepilot-app/installations/new');
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0]).toEqual({
      id: 601,
      accountLogin: 'octocat',
      accountType: 'User',
      repositorySelection: 'all',
      suspended: false,
      linkedWorkspaceId: 'ws-A',
    });
    expect(body.installations[1]).toEqual({
      id: 602,
      accountLogin: 'github-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
      suspended: true,
      linkedWorkspaceId: null,
    });
  });
});

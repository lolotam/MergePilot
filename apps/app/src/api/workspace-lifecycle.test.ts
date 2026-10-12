import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgAdapter } from 'better-auth/plugins/organization';
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

describe('dashboard api - workspace lifecycle (rename and delete)', { timeout: 25000 }, () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let vault: EnvelopeVault;
  let credentials: CredentialService;
  let auth: Auth;

  // Built at runtime so no secret-shaped literal sits in the source.
  const filler = (length: number): string => 'x'.repeat(length);
  const config: AppConfig = {
    baseUrl: 'http://localhost:3000',
    port: 3000,
    databaseUrl: 'postgres://localhost:5432/test',
    redisUrl: 'redis://localhost:6379',
    masterKey: filler(32),
    github: {
      appId: '12345',
      privateKey: 'pem',
      webhookSecret: 'whk',
      clientId: 'gh-id',
      clientSecret: 'ghc',
      appSlug: 'mergepilot-test',
    },
    google: { clientId: 'g-id', clientSecret: 'ggc' },
    authSecret: filler(40),
  };

  beforeEach(async () => {
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
    });

    // Seed users
    await db.insert(authSchema.user).values([
      { id: 'u-owner', name: 'Owner User', email: 'owner@test.com', emailVerified: true },
      { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
      { id: 'u-member', name: 'Member User', email: 'member@test.com', emailVerified: true },
      { id: 'u-outsider', name: 'Outsider User', email: 'outsider@test.com', emailVerified: true },
      { id: 'u-owner-b', name: 'Owner B', email: 'owner-b@test.com', emailVerified: true },
    ]);

    // Seed sessions
    await db.insert(authSchema.session).values([
      { id: 's-owner', token: 't-own', userId: 'u-owner', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-admin', token: 't-adm', userId: 'u-admin', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-member', token: 't-mem', userId: 'u-member', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-outsider', token: 't-out', userId: 'u-outsider', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-owner-b', token: 't-ob', userId: 'u-owner-b', expiresAt: new Date(Date.now() + 86400000) },
    ]);

    // Workspaces
    await db.insert(authSchema.organization).values([
      { id: 'ws-A', name: 'Workspace A', slug: 'workspace-a' },
      { id: 'ws-B', name: 'Workspace B', slug: 'workspace-b' },
    ]);

    // Memberships: ws-A has owner, admin, and member; ws-B has outsider
    await db.insert(authSchema.member).values([
      { id: 'm-owner', organizationId: 'ws-A', userId: 'u-owner', role: 'owner' },
      { id: 'm-admin', organizationId: 'ws-A', userId: 'u-admin', role: 'admin' },
      { id: 'm-member', organizationId: 'ws-A', userId: 'u-member', role: 'member' },
      { id: 'm-outsider', organizationId: 'ws-B', userId: 'u-outsider', role: 'member' },
      { id: 'm-owner-b', organizationId: 'ws-B', userId: 'u-owner-b', role: 'owner' },
    ]);

    await app.ready();
  }, 30000);

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  describe('PATCH /api/workspaces/:workspaceId (rename)', () => {
    it('admin renames workspace and returns { id, name }', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: { name: '  Renamed by Admin  ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'ws-A', name: 'Renamed by Admin' });

      // Verify in Better Auth DB
      const authCtx = (await auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
      const orgAdapter = getOrgAdapter(authCtx);
      const org = await orgAdapter.findOrganizationById('ws-A');
      expect(org?.name).toBe('Renamed by Admin');
    });

    it('owner renames workspace and returns { id, name }', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-own', config.authSecret) },
        payload: { name: 'Renamed by Owner' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'ws-A', name: 'Renamed by Owner' });
    });

    it('rejects invalid names with 400 (empty, whitespace, > 60 chars, missing)', async () => {
      // Empty string
      const resEmpty = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: { name: '' },
      });
      expect(resEmpty.statusCode).toBe(400);

      // Whitespace only
      const resSpaces = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: { name: '     ' },
      });
      expect(resSpaces.statusCode).toBe(400);

      // Longer than 60 characters
      const resTooLong = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: { name: 'a'.repeat(61) },
      });
      expect(resTooLong.statusCode).toBe(400);

      // Missing body or wrong type
      const resNoBody = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: {},
      });
      expect(resNoBody.statusCode).toBe(400);
    });

    it('rejects member with 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-mem', config.authSecret) },
        payload: { name: 'Member Try' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects outsider with 403 and unauthenticated with 401', async () => {
      const resOutsider = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-out', config.authSecret) },
        payload: { name: 'Outsider Try' },
      });
      expect(resOutsider.statusCode).toBe(403);

      const resNoAuth = await app.inject({
        method: 'PATCH',
        url: '/api/workspaces/ws-A',
        payload: { name: 'No Auth Try' },
      });
      expect(resNoAuth.statusCode).toBe(401);
    });
  });

  it('checks the role in the SAME workspace: owner of ws-B gets 403 on PATCH and DELETE of ws-A', async () => {
    const cookie = signedSessionCookie('t-ob', config.authSecret);
    const rename = await app.inject({
      method: 'PATCH',
      url: '/api/workspaces/ws-A',
      headers: { cookie },
      payload: { name: 'Hijacked' },
    });
    expect(rename.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-A',
      headers: { cookie },
      payload: { confirmName: 'Workspace A' },
    });
    expect(del.statusCode).toBe(403);

    const authCtx = (await auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
    const org = await getOrgAdapter(authCtx).findOrganizationById('ws-A');
    expect(org?.name).toBe('Workspace A');
  });

  describe('DELETE /api/workspaces/:workspaceId (delete)', () => {
    it('returns 400 confirm_mismatch if confirmName does not match exactly', async () => {
      const resMismatch = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-own', config.authSecret) },
        payload: { confirmName: 'Wrong Name' },
      });

      expect(resMismatch.statusCode).toBe(400);
      expect(resMismatch.json().error.code).toBe('confirm_mismatch');

      // Missing confirmName
      const resEmpty = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-own', config.authSecret) },
        payload: { confirmName: '' },
      });
      expect(resEmpty.statusCode).toBe(400);
      expect(resEmpty.json().error.code).toBe('confirm_mismatch');

      // Case still matters after trimming
      const resCase = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-own', config.authSecret) },
        payload: { confirmName: '  workspace a  ' },
      });
      expect(resCase.statusCode).toBe(400);
      expect(resCase.json().error.code).toBe('confirm_mismatch');
    });

    it('rejects admin, member, and outsider with 403 (owner only)', async () => {
      // Admin
      const resAdmin = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-adm', config.authSecret) },
        payload: { confirmName: 'Workspace A' },
      });
      expect(resAdmin.statusCode).toBe(403);

      // Member
      const resMember = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-mem', config.authSecret) },
        payload: { confirmName: 'Workspace A' },
      });
      expect(resMember.statusCode).toBe(403);

      // Outsider
      const resOutsider = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-out', config.authSecret) },
        payload: { confirmName: 'Workspace A' },
      });
      expect(resOutsider.statusCode).toBe(403);

      // Unauthenticated
      const resUnauth = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        payload: { confirmName: 'Workspace A' },
      });
      expect(resUnauth.statusCode).toBe(401);
    });

    it('happy path: deletes workspace data, unlinks installation, deletes org, returns 204', async () => {
      // 1. Seed data for ws-A
      await store.saveSettings({
        workspaceId: 'ws-A',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        language: 'ar',
        monthlyBudgetUsd: 50,
      });

      await store.saveCredential({
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'ws-A',
        provider: 'anthropic',
        ciphertext: 'enc:x',
        keyVersion: 1,
        last4: '1234',
        createdBy: 'u-owner',
        createdAt: new Date(),
      });

      await store.createReviewRun({
        workspaceId: 'ws-A',
        installationId: 2001,
        repoFullName: 'org/repo',
        pullNumber: 1,
        headSha: 'sha-1',
        status: 'completed',
        costUsd: 0.05,
        detail: 'Done',
      });

      await store.upsertInstallation({
        id: 2001,
        workspaceId: 'ws-A',
        accountLogin: 'acme-corp',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      // 2. Perform DELETE as owner with exact confirmName
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspaces/ws-A',
        headers: { cookie: signedSessionCookie('t-own', config.authSecret) },
        payload: { confirmName: '  Workspace A  ' },
      });

      // Surrounding spaces are trimmed, matching how rename stores the name
      expect(res.statusCode).toBe(204);

      // 3. Verify workspace-scoped data is gone
      expect(await store.getSettings('ws-A')).toBeNull();
      expect(await store.listCredentials('ws-A')).toEqual([]);
      expect(await store.getCredential('ws-A', 'anthropic')).toBeNull();
      expect(await store.listReviewRuns('ws-A', 10)).toEqual([]);

      // 4. Verify installation is unlinked
      expect(await store.listInstallations('ws-A')).toEqual([]);
      expect(await store.getInstallation(2001)).toBeNull();

      // Installation can be linked to another workspace (ws-B)
      await store.linkInstallation(2001, 'ws-B');
      const relinked = await store.getInstallation(2001);
      expect(relinked?.workspaceId).toBe('ws-B');

      // 5. Verify organization in Better Auth is gone
      const authCtx = (await auth.$context) as unknown as Parameters<typeof getOrgAdapter>[0];
      const orgAdapter = getOrgAdapter(authCtx);
      const org = await orgAdapter.findOrganizationById('ws-A');
      expect(org).toBeNull();

      // Memberships for ws-A are cascaded
      const members = await authCtx.adapter.findMany({
        model: 'member',
        where: [{ field: 'organizationId', value: 'ws-A' }],
      });
      expect(members).toEqual([]);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth, type Auth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

describe('platform admin API routes', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let db: AdminTestDb['db'];
  let auth: Auth;

  const config = adminTestConfig(['admin@mergepilot.com']);

  const adminCookie = signedSessionCookie('tok-admin', config.authSecret);
  const regularCookie = signedSessionCookie('tok-regular', config.authSecret);

  beforeEach(async () => {
    handle = await createAdminTestDb();
    db = handle.db;
    auth = createAuth({ db, config });

    app = fastify();
    registerAuthRoutes(app, auth);
    registerAdminApi(app, { auth, db, config });

    await seedAdminFixtures(db);

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  it('GET /api/admin/overview returns aggregated platform statistics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toBe(2);
    expect(body.workspaces).toBe(2);
    expect(body.installations).toEqual({ linked: 2, pending: 1 });
    expect(body.repositories).toBe(3); // acme/backend, acme/frontend, solo/app
    expect(body.reviewRuns.total).toBe(3);
    expect(body.reviewRuns.last7Days).toBe(3);
    expect(body.reviewRuns.byStatus).toEqual({
      completed: 1,
      failed: 1,
      queued: 1,
    });
    expect(body.costUsd.allTime).toBeCloseTo(0.20, 2);
    expect(body.costUsd.last30Days).toBeCloseTo(0.20, 2);
  });

  it('GET /api/admin/users returns users without any secrets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users.length).toBeGreaterThanOrEqual(2);

    const userEntry = body.users.find((u: { id: string }) => u.id === 'u-regular');
    expect(userEntry).toBeDefined();
    expect(userEntry.email).toBe('user@example.com');
    expect(userEntry.emailVerified).toBe(true);
    expect(userEntry.signInProviders).toEqual(['github', 'google']);
    expect(userEntry.lastSessionAt).toEqual(expect.any(String));
    expect(userEntry.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Acme Corp', role: 'owner' }),
      ]),
    );

    // SECURITY CHECK: no secrets in payload
    const rawText = res.body;
    expect(rawText).not.toContain('fixture-access-value-never-leak');
    expect(rawText).not.toContain('fixture-refresh-value-never-leak');
    expect(rawText).not.toContain('fixture-id-value-never-leak');
    expect(rawText).not.toContain('accessToken');
    expect(rawText).not.toContain('refreshToken');
    expect(rawText).not.toContain('idToken');
    expect(rawText).not.toContain('password');
  });

  it('GET /api/admin/workspaces returns workspaces without credentials ciphertext', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/workspaces',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaces.length).toBe(2);

    const acme = body.workspaces.find((w: { id: string }) => w.id === 'ws-1');
    expect(acme).toBeDefined();
    expect(acme.name).toBe('Acme Corp');
    expect(acme.memberCount).toBe(1);
    expect(acme.ownerEmail).toBe('user@example.com');
    expect(acme.providers).toEqual(['anthropic']);
    expect(acme.lastRunAt).toEqual(expect.any(String));
    expect(acme.installations[0]).toEqual({
      id: 101,
      accountLogin: 'acme-org',
      repositorySelection: 'all',
      suspended: false,
    });
    expect(acme.runsCount).toBe(2);
    expect(acme.costUsdTotal).toBeCloseTo(0.20, 2);
    expect(acme.installations).toHaveLength(1);
    expect(acme.installations[0].accountLogin).toBe('acme-org');

    // SECURITY CHECK: never select or return ciphertext
    const rawText = res.body;
    expect(rawText).not.toContain('vault:secret-ciphertext');
    expect(rawText).not.toContain('ciphertext');
  });

  it('GET /api/admin/runs returns recent runs across all workspaces, supports workspaceId filter', async () => {
    // All runs
    const allRes = await app.inject({
      method: 'GET',
      url: '/api/admin/runs',
      headers: { cookie: adminCookie },
    });
    expect(allRes.statusCode).toBe(200);
    const allBody = allRes.json();
    expect(allBody.runs.length).toBe(3);
    expect(allBody.runs[0]).toHaveProperty('workspaceName');
    expect(allBody.runs[0]).toHaveProperty('repoFullName');
    expect(allBody.runs[0]).toHaveProperty('pullNumber');
    expect(allBody.runs[0]).toHaveProperty('status');

    // Filtered by workspaceId
    const filteredRes = await app.inject({
      method: 'GET',
      url: '/api/admin/runs?workspaceId=ws-1',
      headers: { cookie: adminCookie },
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredBody = filteredRes.json();
    expect(filteredBody.runs.length).toBe(2);
    expect(filteredBody.runs.every((r: { workspaceId: string }) => r.workspaceId === 'ws-1')).toBe(true);
  });

  it('DELETE /api/admin/users/:userId refuses to delete yourself (400)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/u-admin',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_delete_self');
  });

  it('DELETE /api/admin/users/:userId deletes user, cascades, and cleans up orphan workspaces', async () => {
    const infoSpy = vi.spyOn(app.log, 'info');

    // Delete u-regular: leaves ws-1 and ws-2 with 0 members!
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/u-regular',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    // Verify pino log at info with admin user id, action and target id (no emails)
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'u-admin',
        action: 'admin.delete_user',
        targetId: 'u-regular',
      }),
      expect.any(String),
    );
    // Ensure no email in log call
    const logCall = infoSpy.mock.calls.find((c) =>
      typeof c[0] === 'object' && c[0] !== null && (c[0] as { action?: string }).action === 'admin.delete_user',
    );
    expect(JSON.stringify(logCall)).not.toContain('user@example.com');
    expect(JSON.stringify(logCall)).not.toContain('admin@mergepilot.com');

    // User is deleted
    const users = await db.select().from(authSchema.user);
    expect(users.find((u: { id: string }) => u.id === 'u-regular')).toBeUndefined();

    // Accounts, sessions, members are cascaded/deleted
    const accounts = await db.select().from(authSchema.account);
    expect(accounts.find((a: { userId: string }) => a.userId === 'u-regular')).toBeUndefined();

    // Orphan workspaces ws-1 and ws-2 are cleaned up
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs).toHaveLength(0);

    const creds = await db.select().from(dbSchema.providerCredentials);
    expect(creds).toHaveLength(0);

    const settings = await db.select().from(dbSchema.workspaceSettings);
    expect(settings).toHaveLength(0);

    const runs = await db.select().from(dbSchema.reviewRuns);
    expect(runs).toHaveLength(0);

    // Installations 101 and 102 are unlinked (workspaceId set to null)
    const insts = await db.select().from(dbSchema.installations);
    expect(insts.every((i: { workspaceId: string | null }) => i.workspaceId === null)).toBe(true);
  });

  it('DELETE /api/admin/workspaces/:workspaceId deletes workspace data and unlinks installations', async () => {
    const infoSpy = vi.spyOn(app.log, 'info');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/workspaces/ws-1',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'u-admin',
        action: 'admin.delete_workspace',
        targetId: 'ws-1',
      }),
      expect.any(String),
    );

    // Organization ws-1 deleted, ws-2 remains
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs.map((o: { id: string }) => o.id)).toEqual(['ws-2']);

    // ws-1 credentials deleted, ws-2 remains
    const creds = await db.select().from(dbSchema.providerCredentials);
    expect(creds.map((c: { workspaceId: string }) => c.workspaceId)).toEqual(['ws-2']);

    // Installation 101 unlinked
    const inst101 = (await db.select().from(dbSchema.installations)).find((i: { id: number }) => i.id === 101);
    expect(inst101?.workspaceId).toBeNull();
  });

  it('non-admin hitting /api/admin/* replies 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: regularCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('paginates newest first and caps limit at 100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users?limit=500&offset=-3',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(2);

    const page = await app.inject({
      method: 'GET',
      url: '/api/admin/workspaces?limit=1&offset=1',
      headers: { cookie: adminCookie },
    });
    const pageBody = page.json();
    expect(pageBody.workspaces).toHaveLength(1);
    expect(pageBody.total).toBe(2);
    expect(pageBody.limit).toBe(1);
    expect(pageBody.offset).toBe(1);
  });

  it('DELETE user keeps a workspace that still has other members', async () => {
    await db.insert(authSchema.user).values({
      id: 'u-other',
      name: 'Other',
      email: 'other@example.com',
      emailVerified: true,
    });
    await db
      .insert(authSchema.member)
      .values({ id: 'm-3', organizationId: 'ws-1', userId: 'u-other', role: 'member' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/u-regular',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const orgs = await db.select().from(authSchema.organization);
    expect(orgs.map((o) => o.id)).toEqual(['ws-1']);
    const runs = await db.select().from(dbSchema.reviewRuns);
    expect(runs.every((r) => r.workspaceId === 'ws-1')).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('DELETE unknown user or workspace replies 404', async () => {
    const user = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/u-missing',
      headers: { cookie: adminCookie },
    });
    expect(user.statusCode).toBe(404);
    const ws = await app.inject({
      method: 'DELETE',
      url: '/api/admin/workspaces/ws-missing',
      headers: { cookie: adminCookie },
    });
    expect(ws.statusCode).toBe(404);
  });

  it('non-admin DELETE replies 404 and deletes nothing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/workspaces/ws-1',
      headers: { cookie: regularCookie },
    });
    expect(res.statusCode).toBe(404);
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs).toHaveLength(2);
  });
});

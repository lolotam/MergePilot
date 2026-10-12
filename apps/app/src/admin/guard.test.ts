import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth, type Auth } from '../auth/auth.js';
import * as schema from '../auth/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { loadAppConfig, parsePlatformAdmins } from '../core/config.js';
import { isUserPlatformAdmin, requirePlatformAdmin } from './guard.js';
import { adminTestConfig, createAdminTestDb, type AdminTestDb } from './admin.fixtures.js';

describe('requirePlatformAdmin guard', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let db: AdminTestDb['db'];
  let auth: Auth;

  const config = adminTestConfig(['admin@mergepilot.com', 'operator@mergepilot.com']);

  beforeEach(async () => {
    handle = await createAdminTestDb();
    db = handle.db;
    auth = createAuth({ db, config });

    app = fastify();
    registerAuthRoutes(app, auth);

    app.get('/api/admin/test-protected', {
      preHandler: [requirePlatformAdmin(config, auth)],
      handler: async (request) => {
        return { ok: true, adminUser: request.adminUser };
      },
    });

    // Seed test users:
    // 1. Verified platform admin
    await db.insert(schema.user).values({
      id: 'u-admin-verified',
      name: 'Platform Operator',
      email: 'admin@mergepilot.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-admin-verified',
      token: 'tok-admin-verified',
      userId: 'u-admin-verified',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // 2. Unverified platform admin
    await db.insert(schema.user).values({
      id: 'u-admin-unverified',
      name: 'Unverified Operator',
      email: 'operator@mergepilot.com',
      emailVerified: false,
    });
    await db.insert(schema.session).values({
      id: 's-admin-unverified',
      token: 'tok-admin-unverified',
      userId: 'u-admin-unverified',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // 3. Regular verified user (not in platformAdmins list)
    await db.insert(schema.user).values({
      id: 'u-regular',
      name: 'Regular User',
      email: 'regular@user.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-regular',
      token: 'tok-regular',
      userId: 'u-regular',
      expiresAt: new Date(Date.now() + 86400000),
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  it('not signed in replies 404 (do not reveal admin area)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/test-protected',
    });
    expect(res.statusCode).toBe(404);
  });

  it('non-admin user replies 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/test-protected',
      headers: {
        cookie: signedSessionCookie('tok-regular', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('unverified email replies 404 even if email is in platform admins list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/test-protected',
      headers: {
        cookie: signedSessionCookie('tok-admin-unverified', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('verified platform admin replies 200 with admin user attached', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/test-protected',
      headers: {
        cookie: signedSessionCookie('tok-admin-verified', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.adminUser).toEqual({ id: 'u-admin-verified' });
  });

  it('denied reply is identical to an unknown route (does not reveal the admin area)', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/admin/test-protected' });
    const unknown = await app.inject({ method: 'GET', url: '/api/admin/test-protected-x' });
    expect(denied.statusCode).toBe(404);
    expect(Object.keys(denied.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    expect(denied.body).not.toContain('admin user');
  });
});

describe('isUserPlatformAdmin', () => {
  const admins = ['admin@mergepilot.com'];

  it('matches a verified email case-insensitively and ignores surrounding spaces', () => {
    expect(isUserPlatformAdmin({ email: ' Admin@MergePilot.com ', emailVerified: true }, admins)).toBe(true);
  });

  it('rejects unverified, missing or unlisted emails', () => {
    expect(isUserPlatformAdmin({ email: 'admin@mergepilot.com', emailVerified: false }, admins)).toBe(false);
    expect(isUserPlatformAdmin({ email: 'admin@mergepilot.com' }, admins)).toBe(false);
    expect(isUserPlatformAdmin({ email: null, emailVerified: true }, admins)).toBe(false);
    expect(isUserPlatformAdmin({ email: 'other@x.com', emailVerified: true }, admins)).toBe(false);
    expect(isUserPlatformAdmin(null, admins)).toBe(false);
  });

  it('nobody is an admin when the list is empty or missing', () => {
    expect(isUserPlatformAdmin({ email: 'admin@mergepilot.com', emailVerified: true }, [])).toBe(false);
    expect(isUserPlatformAdmin({ email: 'admin@mergepilot.com', emailVerified: true }, undefined)).toBe(false);
  });
});

describe('parsePlatformAdmins', () => {
  it('splits on commas, trims, lower-cases and drops empty entries', () => {
    expect(parsePlatformAdmins(' A@x.com , ,b@Y.com,')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns an empty list for a missing or blank value', () => {
    expect(parsePlatformAdmins(undefined)).toEqual([]);
    expect(parsePlatformAdmins('  ')).toEqual([]);
  });

  it('loadAppConfig reads MERGEPILOT_PLATFORM_ADMINS', () => {
    const env: Record<string, string> = {
      MERGEPILOT_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      MERGEPILOT_MASTER_KEY: 'test-master-key',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test-key',
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'test-secret',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      BETTER_AUTH_SECRET: 'test-secret',
    };
    expect(loadAppConfig(env).platformAdmins).toEqual([]);
    expect(
      loadAppConfig({ ...env, MERGEPILOT_PLATFORM_ADMINS: 'Ops@X.com' }).platformAdmins,
    ).toEqual(['ops@x.com']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAuth } from './auth.js';
import * as schema from './schema.js';
import { requireRole } from './guard.js';
import { registerAuthRoutes } from './fastify.js';
import { roleAtLeast, ROLES } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { signedSessionCookie } from './session-cookie.fixtures.js';

describe('auth guard and roles', () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;

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
    },
    google: { clientId: 'g-id', clientSecret: 'g-secret' },
    authSecret: 'sk-test-secret-32-chars-long-0000000',
  };

  beforeEach(async () => {
    pglite = new PGlite();
    const migrationSql = readFileSync(join(__dirname, '../../migrations/0002_auth.sql'), 'utf-8');
    await pglite.exec(migrationSql);

    db = drizzle(pglite, { schema });
    auth = createAuth({ db, config });

    app = fastify();
    registerAuthRoutes(app, auth);

    // Test protected routes
    app.get('/workspaces/:workspaceId/member-only', {
      preHandler: [requireRole('member', auth)],
      handler: async (request) => {
        return { ok: true, auth: request.auth };
      },
    });

    app.get('/workspaces/:workspaceId/admin-only', {
      preHandler: [requireRole('admin', auth)],
      handler: async (request) => {
        return { ok: true, auth: request.auth };
      },
    });

    app.get('/workspaces/:workspaceId/owner-only', {
      preHandler: [requireRole('owner', auth)],
      handler: async (request) => {
        return { ok: true, auth: request.auth };
      },
    });

    // Populate seed users and organizations
    // User 1: Member of ws-A
    await db.insert(schema.user).values({
      id: 'u-member',
      name: 'Member User',
      email: 'member@test.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-member',
      token: 'token-member',
      userId: 'u-member',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // User 2: Admin of ws-A
    await db.insert(schema.user).values({
      id: 'u-admin',
      name: 'Admin User',
      email: 'admin@test.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-admin',
      token: 'token-admin',
      userId: 'u-admin',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // User 3: Owner of ws-A
    await db.insert(schema.user).values({
      id: 'u-owner',
      name: 'Owner User',
      email: 'owner@test.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-owner',
      token: 'token-owner',
      userId: 'u-owner',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // Workspaces
    await db.insert(schema.organization).values([
      { id: 'ws-A', name: 'Workspace A', slug: 'workspace-a' },
      { id: 'ws-B', name: 'Workspace B', slug: 'workspace-b' },
    ]);

    // Memberships for Workspace A
    await db.insert(schema.member).values([
      { id: 'm-1', organizationId: 'ws-A', userId: 'u-member', role: 'member' },
      { id: 'm-2', organizationId: 'ws-A', userId: 'u-admin', role: 'admin' },
      { id: 'm-3', organizationId: 'ws-A', userId: 'u-owner', role: 'owner' },
    ]);

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('verifies role hierarchy ordering', () => {
    expect(ROLES).toEqual(['member', 'admin', 'owner']);
    expect(roleAtLeast('owner', 'owner')).toBe(true);
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('owner', 'member')).toBe(true);

    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'member')).toBe(true);

    expect(roleAtLeast('member', 'owner')).toBe(false);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('member', 'member')).toBe(true);
  });

  it('unauthenticated request replies 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unsigned session cookie and a bare Bearer token even when the token is valid', async () => {
    const unsigned = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: { cookie: 'better-auth.session_token=token-owner; __Secure-better-auth.session_token=token-owner' },
    });
    expect(unsigned.statusCode).toBe(401);

    const forged = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: { cookie: signedSessionCookie('token-owner', 'not-the-server-secret-0000000000') },
    });
    expect(forged.statusCode).toBe(401);

    const bearer = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: { authorization: 'Bearer token-owner' },
    });
    expect(bearer.statusCode).toBe(401);
  });

  it('member can access member route, but receives 403 on admin and owner routes', async () => {
    // Member hitting member route
    const okRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: {
        cookie: signedSessionCookie('token-member', config.authSecret),
      },
    });
    expect(okRes.statusCode).toBe(200);
    const body = JSON.parse(okRes.body);
    expect(body.ok).toBe(true);
    expect(body.auth).toEqual({
      userId: 'u-member',
      email: 'member@test.com',
      workspaceId: 'ws-A',
      role: 'member',
    });

    // Member hitting admin route -> 403
    const adminRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/admin-only',
      headers: {
        cookie: signedSessionCookie('token-member', config.authSecret),
      },
    });
    expect(adminRes.statusCode).toBe(403);

    // Member hitting owner route -> 403
    const ownerRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/owner-only',
      headers: {
        cookie: signedSessionCookie('token-member', config.authSecret),
      },
    });
    expect(ownerRes.statusCode).toBe(403);
  });

  it('admin can access member and admin routes, but 403 on owner route', async () => {
    const memberRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: {
        cookie: signedSessionCookie('token-admin', config.authSecret),
      },
    });
    expect(memberRes.statusCode).toBe(200);

    const adminRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/admin-only',
      headers: {
        cookie: signedSessionCookie('token-admin', config.authSecret),
      },
    });
    expect(adminRes.statusCode).toBe(200);

    const ownerRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/owner-only',
      headers: {
        cookie: signedSessionCookie('token-admin', config.authSecret),
      },
    });
    expect(ownerRes.statusCode).toBe(403);
  });

  it('owner can access all routes (member, admin, owner)', async () => {
    const memberRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/member-only',
      headers: {
        cookie: signedSessionCookie('token-owner', config.authSecret),
      },
    });
    expect(memberRes.statusCode).toBe(200);

    const adminRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/admin-only',
      headers: {
        cookie: signedSessionCookie('token-owner', config.authSecret),
      },
    });
    expect(adminRes.statusCode).toBe(200);

    const ownerRes = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-A/owner-only',
      headers: {
        cookie: signedSessionCookie('token-owner', config.authSecret),
      },
    });
    expect(ownerRes.statusCode).toBe(200);
  });

  it('negative security test: user of workspace A hitting workspace B replies 403', async () => {
    // Owner of A is NOT a member of B
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws-B/member-only',
      headers: {
        cookie: signedSessionCookie('token-owner', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

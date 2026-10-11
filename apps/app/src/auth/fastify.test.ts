import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAuth } from './auth.js';
import * as schema from './schema.js';
import { registerAuthRoutes, getAuthContext } from './fastify.js';
import { signedSessionCookie } from './session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';

describe('fastify auth integration', () => {
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

    app.get('/test-ctx/:workspaceId', async (req) => {
      const { workspaceId } = req.params as { workspaceId: string };
      const ctx = await getAuthContext(req, auth, workspaceId);
      return { ok: true, auth: ctx };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('mounts routes at /api/auth/*', async () => {
    // Calling /api/auth/get-session without cookie returns 200 with null or empty session
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeNull();
  });

  it('getAuthContext returns null when no user is signed in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test-ctx/ws-1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.auth).toBeNull();
  });

  it('getAuthContext returns AuthContext when user is authenticated member', async () => {
    await db.insert(schema.user).values({
      id: 'u-ctx',
      name: 'Context User',
      email: 'ctx@example.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-ctx',
      token: 'token-ctx',
      userId: 'u-ctx',
      expiresAt: new Date(Date.now() + 86400000),
    });
    await db.insert(schema.organization).values({
      id: 'ws-ctx',
      name: 'WS Context',
      slug: 'ws-ctx',
    });
    await db.insert(schema.member).values({
      id: 'm-ctx',
      organizationId: 'ws-ctx',
      userId: 'u-ctx',
      role: 'admin',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test-ctx/ws-ctx',
      headers: {
        cookie: signedSessionCookie('token-ctx', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.auth).toEqual({
      userId: 'u-ctx',
      email: 'ctx@example.com',
      workspaceId: 'ws-ctx',
      role: 'admin',
    });
  });

  it('getAuthContext returns null when user is authenticated but not a member of workspace', async () => {
    await db.insert(schema.user).values({
      id: 'u-other',
      name: 'Other User',
      email: 'other@example.com',
      emailVerified: true,
    });
    await db.insert(schema.session).values({
      id: 's-other',
      token: 'token-other',
      userId: 'u-other',
      expiresAt: new Date(Date.now() + 86400000),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/test-ctx/ws-nonexistent',
      headers: {
        cookie: signedSessionCookie('token-other', config.authSecret),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.auth).toBeNull();
  });
});

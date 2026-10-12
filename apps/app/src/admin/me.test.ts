import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { CredentialService } from '../credentials/service.js';
import { registerDashboardApi } from '../api/routes.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { adminTestConfig, createAdminTestDb, type AdminTestDb } from './admin.fixtures.js';

describe('GET /api/me isPlatformAdmin', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;

  const config = adminTestConfig(['ops@mergepilot.com']);

  beforeEach(async () => {
    handle = await createAdminTestDb();
    const { db, store } = handle;
    const auth = createAuth({ db, config });
    const credentials = new CredentialService({
      store,
      vault: new EnvelopeVault(Buffer.alloc(32, 1).toString('base64')),
    });

    app = fastify();
    registerAuthRoutes(app, auth);
    registerDashboardApi(app, { auth, store, credentials, config });

    await db.insert(authSchema.user).values([
      { id: 'u-ops', name: 'Ops', email: 'Ops@MergePilot.com', emailVerified: true },
      { id: 'u-user', name: 'User', email: 'user@example.com', emailVerified: true },
    ]);
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(authSchema.session).values([
      { id: 's-ops', token: 'tok-ops', userId: 'u-ops', expiresAt },
      { id: 's-user', token: 'tok-user', userId: 'u-user', expiresAt },
    ]);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  it('is true for a verified listed email (case-insensitive)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: signedSessionCookie('tok-ops', config.authSecret) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isPlatformAdmin).toBe(true);
  });

  it('is false for everyone else', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: signedSessionCookie('tok-user', config.authSecret) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isPlatformAdmin).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createAuth, type Auth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from '../credentials/service.js';
import type { AppConfig } from '../core/config.js';
import { registerDashboardApi } from './routes.js';

describe('dashboard api - workspace routes (settings, keys, runs, usage, redirect)', () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let vault: EnvelopeVault;
  let credentials: CredentialService;
  let auth: Auth;

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
      appSlug: 'mergepilot-test',
    },
    google: { clientId: 'g-id', clientSecret: 'g-secret' },
    authSecret: 'sk-test-secret-32-chars-long-0000000',
  };

  const fixedNow = new Date('2026-10-15T12:00:00.000Z');

  beforeEach(async () => {
    pglite = new PGlite();
    // Every migration, so the stores see the current schema (0006: usage summary, lease).
    await runMigrations(pglite);

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
      now: () => fixedNow,
    });

    // Seed users
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

    // Workspaces
    await db.insert(authSchema.organization).values([
      { id: 'ws-A', name: 'Workspace A', slug: 'workspace-a' },
      { id: 'ws-B', name: 'Workspace B', slug: 'workspace-b' },
    ]);

    // Memberships: ws-A has member and admin; ws-B has outsider as member
    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: 'ws-A', userId: 'u-member', role: 'member' },
      { id: 'm-2', organizationId: 'ws-A', userId: 'u-admin', role: 'admin' },
      { id: 'm-3', organizationId: 'ws-B', userId: 'u-outsider', role: 'member' },
    ]);

    await app.ready();
  }, 30000);

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  it('GET /api/workspaces/:workspaceId/settings enforces role and isolation', async () => {
    // 401 unauthenticated
    const res401 = await app.inject({ method: 'GET', url: '/api/workspaces/ws-A/settings' });
    expect(res401.statusCode).toBe(401);

    // 403 outsider
    const res403 = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-outsider', config.authSecret) },
    });
    expect(res403.statusCode).toBe(403);

    // 200 member: initially null
    const res200 = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(res200.statusCode).toBe(200);
    expect(res200.json()).toEqual({ settings: null, settingsVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('PUT /api/workspaces/:workspaceId/settings requires admin, validates schema, rejects claude-code', async () => {
    // Member cannot update (403)
    const memberPut = await app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
      payload: { provider: 'anthropic', model: 'claude-3-5-sonnet', language: 'en', monthlyBudgetUsd: 100 },
    });
    expect(memberPut.statusCode).toBe(403);

    // Invalid schema / claude-code rejected (400)
    const claudeCodePut = await app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
      payload: { provider: 'claude-code', model: 'claude-code-cli', language: 'en', monthlyBudgetUsd: 50 },
    });
    expect(claudeCodePut.statusCode).toBe(400);

    // Admin saves valid settings (200)
    const adminPut = await app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
      payload: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest', language: 'ar', monthlyBudgetUsd: 150 },
    });
    expect(adminPut.statusCode).toBe(200);
    expect(adminPut.json()).toEqual({
      settingsVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
      settings: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        language: 'ar',
        monthlyBudgetUsd: 150,
        perReviewUsd: 0.5,
        effort: null,
        heavyProvider: null,
        heavyModel: null,
        heavyEffort: null,
        heavyThresholdLines: 800,
        fallback: [],
        minSeverity: 'medium',
        maxFindings: 5,
        runRetentionDays: 30,
        repoColors: {},
        judge: null,
        priceOverrides: [],
        botName: 'MergePilot',
        botLogo: 'pilot',
        panelMode: 'separate',
        panelMinAgreement: 1,
      },
    });

    // Verify GET now returns saved settings
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/settings',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().settings?.monthlyBudgetUsd).toBe(150);
    expect(getRes.json().settingsVersion).toBe(adminPut.json().settingsVersion);
  });

  it('keys routes: GET/PUT/DELETE enforce admin, 422 on validation failure, never leak plaintext/ciphertext', async () => {
    // Member hitting GET keys -> 403
    const memberGet = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/keys',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(memberGet.statusCode).toBe(403);

    // PUT invalid provider -> 400
    const invalidProvider = await app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/keys/unknown-provider',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
      payload: { apiKey: 'sk-ant-api-test-key-1234' },
    });
    expect(invalidProvider.statusCode).toBe(400);

    // PUT validation failure -> 422, nothing stored
    const failValidateApp = fastify();
    registerAuthRoutes(failValidateApp, auth);
    registerDashboardApi(failValidateApp, {
      auth,
      store,
      credentials,
      config,
      validateKey: vi.fn(async () => {
        throw new Error('invalid key for openai');
      }),
    });
    await failValidateApp.ready();

    const failRes = await failValidateApp.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/keys/openai',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
      payload: { apiKey: 'sk-proj-invalid-12345' },
    });
    expect(failRes.statusCode).toBe(422);
    expect(failRes.json().error.code).toBe('validation_failed');
    await failValidateApp.close();

    // Verify nothing stored
    const keysAfterFail = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/keys',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(keysAfterFail.json().keys).toEqual([]);

    // PUT success with valid key -> 200
    const passValidateApp = fastify();
    registerAuthRoutes(passValidateApp, auth);
    registerDashboardApi(passValidateApp, {
      auth,
      store,
      credentials,
      config,
      validateKey: vi.fn(async () => {}),
    });
    await passValidateApp.ready();

    const rawKey = 'sk-ant-secret-real-looking-12345';
    const putRes = await passValidateApp.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-A/keys/anthropic',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
      payload: { apiKey: rawKey },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json();
    expect(putBody.provider).toBe('anthropic');
    expect(putBody.last4).toBe('2345');
    // Security check: raw key and ciphertext never in response
    expect(JSON.stringify(putBody)).not.toContain(rawKey);
    expect(JSON.stringify(putBody)).not.toContain('ciphertext');

    // GET keys -> shows last4, never plaintext or ciphertext
    const listRes = await passValidateApp.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/keys',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0].last4).toBe('2345');
    expect(JSON.stringify(listBody)).not.toContain(rawKey);
    expect(JSON.stringify(listBody)).not.toContain('ciphertext');

    // DELETE key -> 204
    const deleteRes = await passValidateApp.inject({
      method: 'DELETE',
      url: '/api/workspaces/ws-A/keys/anthropic',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(deleteRes.statusCode).toBe(204);

    const listAfterDelete = await passValidateApp.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/keys',
      headers: { cookie: signedSessionCookie('token-admin', config.authSecret) },
    });
    expect(listAfterDelete.json().keys).toEqual([]);
    await passValidateApp.close();
  });

  it('GET /api/workspaces/:workspaceId/runs rejects limit above 100, defaults to 50, returns total', async () => {
    // Seed 3 review runs
    for (let i = 1; i <= 3; i++) {
      await store.createReviewRun({
        workspaceId: 'ws-A',
        installationId: 1000,
        repoFullName: 'org/repo',
        pullNumber: i,
        headSha: `sha-${i}`,
        status: 'completed',
        costUsd: 0.05 * i,
        detail: `Run ${i}`,
      });
    }

    // Default limit
    const resDefault = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/runs',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(resDefault.statusCode).toBe(200);
    expect(resDefault.json().runs).toHaveLength(3);
    expect(resDefault.json().total).toBe(3);

    // limit above 100 is rejected; 100 is passed through
    const spy = vi.spyOn(store, 'listReviewRuns');
    const resTooBig = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/runs?limit=300',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(resTooBig.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/runs?limit=100',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(spy).toHaveBeenCalledWith('ws-A', expect.objectContaining({ limit: 100 }));
    spy.mockRestore();
  });

  it('GET /api/workspaces/:workspaceId/usage calculates cost from first day of UTC month', async () => {
    // Run inside current month (2026-10-10)
    const runInMonth = await store.createReviewRun({
      workspaceId: 'ws-A',
      installationId: 1000,
      repoFullName: 'org/repo',
      pullNumber: 1,
      headSha: 'sha-1',
      status: 'completed',
      costUsd: 1.25,
      detail: null,
    });
    await store.finishReviewRun('ws-A', runInMonth.id, { status: 'completed', costUsd: 1.25, detail: null });

    await store.saveSettings({
      workspaceId: 'ws-A',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      language: 'en',
      monthlyBudgetUsd: 50,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-A/usage',
      headers: { cookie: signedSessionCookie('token-member', config.authSecret) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.monthCostUsd).toBeCloseTo(1.25, 2);
    expect(body.monthlyBudgetUsd).toBe(50);
    expect(body.monthStart).toBe('2026-10-01T00:00:00.000Z');
  });

  it('GET /app/installed validates digits and redirects to /install?installation_id=...', async () => {
    // Valid digits -> 302
    const valid = await app.inject({
      method: 'GET',
      url: '/app/installed?installation_id=98765&setup_action=install',
    });
    expect(valid.statusCode).toBe(302);
    expect(valid.headers.location).toBe('/install?installation_id=98765');

    // Invalid digits -> 400
    const invalid = await app.inject({
      method: 'GET',
      url: '/app/installed?installation_id=abc&setup_action=install',
    });
    expect(invalid.statusCode).toBe(400);

    // Missing installation_id -> 400
    const missing = await app.inject({
      method: 'GET',
      url: '/app/installed',
    });
    expect(missing.statusCode).toBe(400);
  });
});

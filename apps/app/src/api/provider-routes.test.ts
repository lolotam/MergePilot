import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmFailure } from '@mergepilot/engine';
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
import { resetProviderTestRateLimits } from './provider-routes.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return {
    ...actual,
    listModels: vi.fn(actual.listModels),
    testConnection: vi.fn(actual.testConnection),
  };
});

describe('provider routes (models, connection test, settings validation)', { timeout: 25000 }, () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let vault: EnvelopeVault;
  let credentials: CredentialService;
  let auth: Auth;

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

  const adminCookie = () => signedSessionCookie('t-adm', config.authSecret);
  const memberCookie = () => signedSessionCookie('t-mem', config.authSecret);

  beforeEach(async () => {
    vi.clearAllMocks();
    resetProviderTestRateLimits();
    pglite = new PGlite();
    for (const f of ['0001_app.sql', '0002_auth.sql', '0003_review_run_details.sql', '0004_active_run_unique.sql', '0005_settings_models.sql']) {
      await pglite.exec(readFileSync(join(__dirname, '../../migrations', f), 'utf-8'));
    }

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
      { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
      { id: 'u-member', name: 'Member User', email: 'member@test.com', emailVerified: true },
    ]);

    // Seed sessions
    await db.insert(authSchema.session).values([
      { id: 's-admin', token: 't-adm', userId: 'u-admin', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-member', token: 't-mem', userId: 'u-member', expiresAt: new Date(Date.now() + 86400000) },
    ]);

    // Workspace
    await db.insert(authSchema.organization).values([
      { id: 'ws-1', name: 'Workspace 1', slug: 'workspace-1' },
    ]);

    // Memberships
    await db.insert(authSchema.member).values([
      { id: 'm-admin', organizationId: 'ws-1', userId: 'u-admin', role: 'admin' },
      { id: 'm-member', organizationId: 'ws-1', userId: 'u-member', role: 'member' },
    ]);

    await app.ready();
  }, 30000);

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  describe('GET & POST /api/workspaces/:workspaceId/providers/:provider/models', () => {
    it('returns models for stored key, caches for 10 min, and busts cache on ?refresh=true', async () => {
      const { listModels } = await import('@mergepilot/engine');
      vi.mocked(listModels).mockResolvedValue([
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', efforts: ['low', 'medium', 'high'] },
      ]);

      // Save a key for anthropic
      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'anthropic',
        apiKey: 'sk-ant-test-key-123',
        userId: 'u-admin',
      });

      // 1. First GET: fetches from engine
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/workspaces/ws-1/providers/anthropic/models',
        headers: { cookie: memberCookie() },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json()).toEqual({
        models: [{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', efforts: ['low', 'medium', 'high'] }],
      });
      expect(listModels).toHaveBeenCalledTimes(1);

      // 2. Second GET: returns from 10-minute cache without calling listModels again
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/workspaces/ws-1/providers/anthropic/models',
        headers: { cookie: memberCookie() },
      });
      expect(res2.statusCode).toBe(200);
      expect(listModels).toHaveBeenCalledTimes(1);

      // 3. Third GET with ?refresh=true: busts cache and calls listModels again
      const res3 = await app.inject({
        method: 'GET',
        url: '/api/workspaces/ws-1/providers/anthropic/models?refresh=true',
        headers: { cookie: memberCookie() },
      });
      expect(res3.statusCode).toBe(200);
      expect(listModels).toHaveBeenCalledTimes(2);
    });

    it('returns 404 key_not_found when no key stored for provider', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/workspaces/ws-1/providers/openai/models',
        headers: { cookie: memberCookie() },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('key_not_found');
    });

    it('POST /models tests unsaved key without storing it, and never logs secret', async () => {
      const { listModels } = await import('@mergepilot/engine');
      vi.mocked(listModels).mockResolvedValue([
        { id: 'gpt-4o', name: 'GPT-4o', efforts: [] },
      ]);

      const rawKey = 'sk-test-unsaved-secret-999';
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/providers/openai/models',
        headers: { cookie: adminCookie() },
        payload: { apiKey: rawKey },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        models: [{ id: 'gpt-4o', name: 'GPT-4o', efforts: [] }],
      });
      expect(res.body).not.toContain(rawKey);

      // Verify key was NOT stored
      const stored = await credentials.getCredential('ws-1', 'openai');
      expect(stored).toBeNull();
    });

    it('maps LlmFailure to error codes and redacts secrets from responses', async () => {
      const { listModels } = await import('@mergepilot/engine');
      const rawKey = 'sk-ant-failing-secret-xyz';
      vi.mocked(listModels).mockRejectedValueOnce(
        new LlmFailure({
          code: 'INVALID_CREDENTIAL',
          message: `Auth failed with key ${rawKey}`,
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/providers/anthropic/models',
        headers: { cookie: adminCookie() },
        payload: { apiKey: rawKey },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('auth');
      expect(res.json().error.message).not.toContain(rawKey);
      expect(res.json().error.message).toContain('[REDACTED]');
    });

    it('enforces SSRF guard for custom provider base URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/providers/custom/models',
        headers: { cookie: adminCookie() },
        payload: { apiKey: 'sk-test-000', baseUrl: 'http://127.0.0.1:11434/v1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ssrf_validation_error');
    });
  });

  describe('POST /api/workspaces/:workspaceId/credentials/:provider/test', () => {
    it('returns ok: true with ms and model on successful testConnection', async () => {
      const { testConnection } = await import('@mergepilot/engine');
      vi.mocked(testConnection).mockResolvedValue({
        ok: true,
        ms: 120,
        model: 'gpt-5',
        reply: 'OK',
      });

      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'openai',
        apiKey: 'sk-test-openai-key',
        userId: 'u-admin',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/credentials/openai/test',
        headers: { cookie: adminCookie() },
        payload: { model: 'gpt-5' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, ms: 120, model: 'gpt-5' });
    });

    it('returns ok: false with code and redacted message on failed test', async () => {
      const { testConnection } = await import('@mergepilot/engine');
      vi.mocked(testConnection).mockResolvedValue({
        ok: false,
        ms: 45,
        code: 'auth',
        message: 'Invalid API key',
      });

      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'openai',
        apiKey: 'sk-test-openai-bad',
        userId: 'u-admin',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/credentials/openai/test',
        headers: { cookie: adminCookie() },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false, code: 'auth', message: 'Invalid API key', ms: 45 });
    });

    it('rate-limits tests to 10 per minute per workspace', async () => {
      const { testConnection } = await import('@mergepilot/engine');
      vi.mocked(testConnection).mockResolvedValue({
        ok: true,
        ms: 10,
        model: 'gpt-4o',
        reply: 'OK',
      });

      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'openai',
        apiKey: 'sk-test-openai-rate',
        userId: 'u-admin',
      });

      // 10 requests succeed
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/workspaces/ws-1/credentials/openai/test',
          headers: { cookie: adminCookie() },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      }

      // 11th request is rate-limited (429)
      const limitedRes = await app.inject({
        method: 'POST',
        url: '/api/workspaces/ws-1/credentials/openai/test',
        headers: { cookie: adminCookie() },
        payload: {},
      });
      expect(limitedRes.statusCode).toBe(429);
      expect(limitedRes.json().error.code).toBe('rate_limited');
    });
  });

  describe('PUT /api/workspaces/:workspaceId/settings validation', () => {
    it('validates that each fallback entry has a stored API key in the workspace', async () => {
      // Save key for anthropic ONLY
      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'anthropic',
        apiKey: 'sk-ant-key-valid',
        userId: 'u-admin',
      });

      // Attempt to save fallback with 'gemini' (no key stored)
      const injectPut = (payload: unknown) =>
        app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: adminCookie() }, payload });

      const res = await injectPut({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        language: 'ar',
        fallback: [{ provider: 'gemini', model: 'gemini-3.8-flash' }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('fallback_key_missing');
      expect(res.json().error.message).toContain('gemini');
    });

    it('validates heavy model: requires stored key for heavyProvider', async () => {
      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'anthropic',
        apiKey: 'sk-ant-key-valid',
        userId: 'u-admin',
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspaces/ws-1/settings',
        headers: { cookie: adminCookie() },
        payload: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          language: 'ar',
          heavyProvider: 'openai',
          heavyModel: 'gpt-5',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('heavy_key_missing');
    });

    it('validates min severity: accepts valid severity, rejects invalid', async () => {
      await credentials.saveKey({
        workspaceId: 'ws-1',
        provider: 'anthropic',
        apiKey: 'sk-ant-key-valid',
        userId: 'u-admin',
      });

      const injectPut = (minSeverity: string) =>
        app.inject({
          method: 'PUT',
          url: '/api/workspaces/ws-1/settings',
          headers: { cookie: adminCookie() },
          payload: { provider: 'anthropic', model: 'claude-3-5-sonnet', language: 'ar', minSeverity },
        });

      const resBad = await injectPut('invalid-severity');
      expect(resBad.statusCode).toBe(400);

      const resGood = await injectPut('high');
      expect(resGood.statusCode).toBe(200);
      expect(resGood.json().settings.minSeverity).toBe('high');
    });
  });
});

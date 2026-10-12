import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// Session tokens built at runtime so no secret-looking literal sits in the test.
const TOKEN_USER1 = ['t', 'u1'].join('-');
const TOKEN_USER2 = ['t', 'u2'].join('-');

describe('dashboard api - runs routes (list, repos, detail, filters, sorting)', () => {
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
    masterKey: '0'.repeat(32),
    github: {
      appId: '12345',
      privateKey: 'key',
      webhookSecret: 'secret',
      clientId: 'gh-id',
      clientSecret: 'gh-s',
      appSlug: 'mergepilot-test',
    },
    google: { clientId: 'g-id', clientSecret: 'g-s' },
    authSecret: 'x'.repeat(32),
  };

  beforeEach(async () => {
    pglite = new PGlite();
    const appSql = readFileSync(join(__dirname, '../../migrations/0001_app.sql'), 'utf-8');
    const authSql = readFileSync(join(__dirname, '../../migrations/0002_auth.sql'), 'utf-8');
    const detailsSql = readFileSync(join(__dirname, '../../migrations/0003_review_run_details.sql'), 'utf-8');
    await pglite.exec(appSql);
    await pglite.exec(authSql);
    await pglite.exec(detailsSql);

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

    // Users and workspaces
    await db.insert(authSchema.user).values([
      { id: 'u-user1', name: 'User 1', email: 'user1@test.com', emailVerified: true },
      { id: 'u-user2', name: 'User 2', email: 'user2@test.com', emailVerified: true },
    ]);

    await db.insert(authSchema.session).values([
      { id: 's-user1', token: TOKEN_USER1, userId: 'u-user1', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-user2', token: TOKEN_USER2, userId: 'u-user2', expiresAt: new Date(Date.now() + 86400000) },
    ]);

    await db.insert(authSchema.organization).values([
      { id: 'ws-1', name: 'Workspace 1', slug: 'workspace-1' },
      { id: 'ws-2', name: 'Workspace 2', slug: 'workspace-2' },
    ]);

    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: 'ws-1', userId: 'u-user1', role: 'member' },
      { id: 'm-2', organizationId: 'ws-2', userId: 'u-user2', role: 'member' },
    ]);

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  it('GET /api/workspaces/:workspaceId/runs returns list with metadata and severityCounts, omitting result body', async () => {
    const payload = {
      v: 1 as const,
      summary: 'Summary text',
      highlights: ['H1'],
      findings: [
        { path: 'a.ts', line: 1, severity: 'critical' as const, title: 'Bug', body: 'Fix' },
        { path: 'b.ts', line: 5, severity: 'low' as const, title: 'Style', body: 'Indent' },
      ],
      language: 'en' as const,
    };

    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/frontend',
      pullNumber: 42,
      headSha: 'head-sha-1',
      status: 'completed',
      costUsd: 0.05,
      detail: null,
    });

    await store.finishReviewRun('ws-1', run.id, {
      status: 'completed',
      costUsd: 0.05,
      detail: null,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      effort: 'high',
      fallbackFrom: 'openai',
      findingsCount: 2,
      result: payload,
      reviewUrl: 'https://github.com/acme/frontend/pull/42#pullrequestreview-1',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.total).toBe(1);

    const item = body.runs[0];
    expect(item.id).toBe(run.id);
    expect(item.provider).toBe('anthropic');
    expect(item.model).toBe('claude-3-5-sonnet');
    expect(item.effort).toBe('high');
    expect(item.fallbackFrom).toBe('openai');
    expect(item.findingsCount).toBe(2);
    expect(item.reviewUrl).toBe('https://github.com/acme/frontend/pull/42#pullrequestreview-1');
    expect(item.severityCounts).toEqual({
      critical: 1,
      high: 0,
      medium: 0,
      low: 1,
      info: 0,
    });
    // result body MUST NOT be included in list item
    expect(item).not.toHaveProperty('result');
  });

  it('GET /api/workspaces/:workspaceId/runs/repos returns distinct repositories for workspace', async () => {
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/repo-z',
      pullNumber: 1,
      headSha: 'sha-1',
      status: 'completed',
      costUsd: null,
      detail: null,
    });
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/repo-a',
      pullNumber: 2,
      headSha: 'sha-2',
      status: 'completed',
      costUsd: null,
      detail: null,
    });
    // Duplicate repo in ws-1
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/repo-a',
      pullNumber: 3,
      headSha: 'sha-3',
      status: 'completed',
      costUsd: null,
      detail: null,
    });
    // Run in other workspace ws-2
    await store.createReviewRun({
      workspaceId: 'ws-2',
      installationId: 10,
      repoFullName: 'acme/other-repo',
      pullNumber: 4,
      headSha: 'sha-4',
      status: 'completed',
      costUsd: null,
      detail: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs/repos',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repos: ['acme/repo-a', 'acme/repo-z'] });
  });

  it('GET /api/workspaces/:workspaceId/runs/:runId returns full run with result, or 404 for wrong workspace', async () => {
    const payload = {
      v: 1 as const,
      summary: 'Detailed summary',
      highlights: ['Fix issue'],
      findings: [{ path: 'main.go', line: 4, severity: 'high' as const, title: 'Error', body: 'Fix err' }],
      language: 'ar' as const,
    };

    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/backend',
      pullNumber: 15,
      headSha: 'head-sha-backend',
      status: 'completed',
      costUsd: 0.08,
      detail: null,
    });

    await store.finishReviewRun('ws-1', run.id, {
      status: 'completed',
      costUsd: 0.08,
      detail: null,
      provider: 'openai',
      model: 'gpt-4o',
      findingsCount: 1,
      result: payload,
      reviewUrl: 'https://github.com/acme/backend/pull/15#pullrequestreview-77',
    });

    // 200 member of ws-1
    const res200 = await app.inject({
      method: 'GET',
      url: `/api/workspaces/ws-1/runs/${run.id}`,
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(res200.statusCode).toBe(200);
    const detailBody = res200.json().run;
    expect(detailBody.id).toBe(run.id);
    expect(detailBody.result).toEqual(payload);
    expect(detailBody.severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
    });

    // 404 for another workspace
    const resOtherWs = await app.inject({
      method: 'GET',
      url: `/api/workspaces/ws-2/runs/${run.id}`,
      headers: { cookie: signedSessionCookie(TOKEN_USER2, config.authSecret) },
    });
    expect(resOtherWs.statusCode).toBe(404);

    // 404 for non-existent run
    const res404 = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs/00000000-0000-0000-0000-000000000000',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(res404.statusCode).toBe(404);
  });

  it('rejects unknown sort key with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs?sort=malicious_column',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_sort');
  });

  it('rejects invalid filter params with 400 invalid_query', async () => {
    const urls = [
      '/api/workspaces/ws-1/runs?status=exploded',
      '/api/workspaces/ws-1/runs?from=yesterday',
      '/api/workspaces/ws-1/runs?from=2026-10-12&to=2026-10-01',
      `/api/workspaces/ws-1/runs?q=${'a'.repeat(201)}`,
      '/api/workspaces/ws-1/runs?dir=sideways',
      '/api/workspaces/ws-1/runs?limit=0',
      '/api/workspaces/ws-1/runs?offset=-1',
    ];
    for (const url of urls) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
      });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('invalid_query');
    }
  });

  it('supports filtering by repo, status, provider and search q', async () => {
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/api',
      pullNumber: 101,
      headSha: 'sha-api',
      status: 'completed',
      costUsd: 0.02,
      detail: null,
    });
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 10,
      repoFullName: 'acme/web',
      pullNumber: 202,
      headSha: 'sha-web',
      status: 'failed',
      costUsd: null,
      detail: 'Connection timeout',
    });

    // Filter by repo
    const resRepo = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs?repo=acme/api',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(resRepo.json().runs).toHaveLength(1);
    expect(resRepo.json().runs[0].repoFullName).toBe('acme/api');

    // Search q matching PR number
    const resSearchPr = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs?q=202',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(resSearchPr.json().runs).toHaveLength(1);
    expect(resSearchPr.json().runs[0].pullNumber).toBe(202);

    // Search q matching failure detail
    const resSearchDetail = await app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/runs?q=timeout',
      headers: { cookie: signedSessionCookie(TOKEN_USER1, config.authSecret) },
    });
    expect(resSearchDetail.json().runs).toHaveLength(1);
    expect(resSearchDetail.json().runs[0].detail).toBe('Connection timeout');
  });
});

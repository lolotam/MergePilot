import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { registerDashboardApi } from './routes.js';
import { resetRetryRateLimits } from './runs-retry.js';

const TOKEN_ADMIN = ['t', 'adm'].join('-');
const TOKEN_MEMBER = ['t', 'mem'].join('-');
const TOKEN_OTHER = ['t', 'oth'].join('-');

describe('dashboard api - POST /api/workspaces/:workspaceId/runs/retry-failed', { timeout: 25000 }, () => {
  let app: FastifyInstance;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let vault: EnvelopeVault;
  let credentials: CredentialService;
  let auth: Auth;
  let enqueuedJobs: ReviewJob[];
  let mockQueue: ReviewQueue;
  let mockPrResponses: Map<string, { state?: string; merged?: boolean; head: { sha: string }; base?: { sha: string } }>;
  let mockAppFactory: GitHubAppClientFactory;

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
    resetRetryRateLimits();
    enqueuedJobs = [];
    mockQueue = {
      async enqueue(job: ReviewJob) {
        enqueuedJobs.push(job);
      },
    };
    mockPrResponses = new Map();

    mockAppFactory = async () => ({
      client: {
        async getPullRequest(params: { owner: string; repo: string; pull_number: number }) {
          const key = `${params.owner}/${params.repo}#${params.pull_number}`;
          const res = mockPrResponses.get(key);
          if (!res) {
            return {
              state: 'open',
              merged: false,
              head: { sha: 'sha-current-head' },
              base: { sha: 'sha-base-1' },
            } as unknown as Awaited<ReturnType<Parameters<GitHubAppClientFactory>[0]['client']['getPullRequest']>>;
          }
          return res as unknown as Awaited<ReturnType<Parameters<GitHubAppClientFactory>[0]['client']['getPullRequest']>>;
        },
      } as unknown as Parameters<GitHubAppClientFactory>[0]['client'],
      publisherLogin: 'mergepilot-test[bot]',
    });

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
      queue: mockQueue,
      githubAppFactory: mockAppFactory,
    });

    await db.insert(authSchema.user).values([
      { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
      { id: 'u-member', name: 'Member User', email: 'member@test.com', emailVerified: true },
      { id: 'u-other', name: 'Other User', email: 'other@test.com', emailVerified: true },
    ]);
    await db.insert(authSchema.session).values([
      { id: 's-admin', token: TOKEN_ADMIN, userId: 'u-admin', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-member', token: TOKEN_MEMBER, userId: 'u-member', expiresAt: new Date(Date.now() + 86400000) },
      { id: 's-other', token: TOKEN_OTHER, userId: 'u-other', expiresAt: new Date(Date.now() + 86400000) },
    ]);
    await db.insert(authSchema.organization).values([
      { id: 'ws-1', name: 'Workspace 1', slug: 'workspace-1' },
      { id: 'ws-2', name: 'Workspace 2', slug: 'workspace-2' },
    ]);
    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: 'ws-1', userId: 'u-admin', role: 'admin' },
      { id: 'm-2', organizationId: 'ws-1', userId: 'u-member', role: 'member' },
      { id: 'm-3', organizationId: 'ws-2', userId: 'u-other', role: 'admin' },
    ]);

    await store.upsertInstallation({
      id: 100,
      workspaceId: 'ws-1',
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    await app.ready();
  }, 30000);

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  it('picks latest-per-PR whose latest status is failed, skips closed/running, respects cap', async () => {
    // PR 1: run1 failed, run2 completed -> latest completed -> NOT picked
    const pr1Run1 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 1,
      headSha: 'sha-1a',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr1Run1.id, { status: 'failed', costUsd: null, detail: 'err' });
    const pr1Run2 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 1,
      headSha: 'sha-1b',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr1Run2.id, { status: 'completed', costUsd: 0.01, detail: null });

    // PR 2: run1 completed, run2 failed -> latest failed -> should be queued!
    const pr2Run1 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 2,
      headSha: 'sha-2a',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr2Run1.id, { status: 'completed', costUsd: 0.01, detail: null });
    const pr2Run2 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 2,
      headSha: 'sha-2b',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr2Run2.id, { status: 'failed', costUsd: null, detail: 'err' });

    // PR 3: latest failed, but PR is closed on GitHub -> skipped pr_closed
    const pr3 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 3,
      headSha: 'sha-3',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr3.id, { status: 'failed', costUsd: null, detail: 'err' });
    mockPrResponses.set('acme/app#3', { state: 'closed', merged: false, head: { sha: 'sha-3' } });

    // PR 4: latest failed, but an active run for its current head exists -> skipped already_running
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 4,
      headSha: 'sha-4-active',
      status: 'queued',
      costUsd: null,
      detail: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    const pr4Failed = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 4,
      headSha: 'sha-4-old',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr4Failed.id, { status: 'failed', costUsd: null, detail: 'err' });
    mockPrResponses.set('acme/app#4', { state: 'open', merged: false, head: { sha: 'sha-4-active' } });

    // PR 5: single failed run, open -> queued!
    const pr5 = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 5,
      headSha: 'sha-5',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', pr5.id, { status: 'failed', costUsd: null, detail: 'err' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/retry-failed',
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
      payload: { repo: ['acme/app'] },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.queued).toBe(2); // PR 2 and PR 5
    expect(data.skipped).toEqual(
      expect.arrayContaining([
        { repo: 'acme/app', pullNumber: 3, reason: 'pr_closed' },
        { repo: 'acme/app', pullNumber: 4, reason: 'already_running' },
      ]),
    );
    expect(enqueuedJobs).toHaveLength(2);
  });

  it('enforces rate limit of one call per minute per workspace', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/retry-failed',
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
      payload: {},
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/retry-failed',
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
      payload: {},
    });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error.code).toBe('rate_limited');

    const resOtherWs = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-2/runs/retry-failed',
      headers: { cookie: signedSessionCookie(TOKEN_OTHER, config.authSecret) },
      payload: {},
    });
    expect(resOtherWs.statusCode).toBe(200);
  });

  it('rejects member with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/retry-failed',
      headers: { cookie: signedSessionCookie(TOKEN_MEMBER, config.authSecret) },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

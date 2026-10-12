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
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { registerDashboardApi } from './routes.js';
import { resetRetryRateLimits } from './runs-retry.js';

const TOKEN_ADMIN = ['t', 'adm'].join('-');
const TOKEN_MEMBER = ['t', 'mem'].join('-');
const TOKEN_OTHER = ['t', 'oth'].join('-');

describe('dashboard api - POST /api/workspaces/:workspaceId/runs/:runId/retry', { timeout: 25000 }, () => {
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
    const appSql = readFileSync(join(__dirname, '../../migrations/0001_app.sql'), 'utf-8');
    const authSql = readFileSync(join(__dirname, '../../migrations/0002_auth.sql'), 'utf-8');
    const detailsSql = readFileSync(join(__dirname, '../../migrations/0003_review_run_details.sql'), 'utf-8');
    const activeRunSql = readFileSync(join(__dirname, '../../migrations/0004_active_run_unique.sql'), 'utf-8');
    await pglite.exec(appSql);
    await pglite.exec(authSql);
    await pglite.exec(detailsSql);
    await pglite.exec(activeRunSql);

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

    // Users & sessions
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

    // Seed installation linked to ws-1
    await store.upsertInstallation({
      id: 100,
      workspaceId: 'ws-1',
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await pglite.close();
  });

  it('retry happy path: creates new queued run, enqueues job once, returns 202', async () => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-retry',
      pullNumber: 42,
      headSha: 'sha-old-head',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', run.id, {
      status: 'failed',
      costUsd: null,
      detail: 'Timeout error',
    });

    mockPrResponses.set('acme/repo-retry#42', {
      state: 'open',
      merged: false,
      head: { sha: 'sha-new-head' },
      base: { sha: 'sha-base-master' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${run.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.runId).toBeDefined();
    expect(body.runId).not.toBe(run.id);

    // Verify new run in store
    const newRun = await store.getReviewRun('ws-1', body.runId);
    expect(newRun).not.toBeNull();
    expect(newRun?.status).toBe('queued');
    expect(newRun?.headSha).toBe('sha-new-head');
    expect(newRun?.jobId).toMatch(/^retry-/);

    // Verify job enqueued once in queue
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]?.deliveryId).toBe(newRun?.jobId);
    expect(enqueuedJobs[0]?.headSha).toBe('sha-new-head');
    expect(enqueuedJobs[0]?.baseSha).toBe('sha-base-master');
    expect(enqueuedJobs[0]?.pullNumber).toBe(42);
  });

  it('marks the new run failed and returns 503 when the queue rejects the job', async () => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-qfail',
      pullNumber: 43,
      headSha: 'sha-a',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', run.id, { status: 'failed', costUsd: null, detail: 'x' });
    mockPrResponses.set('acme/repo-qfail#43', {
      state: 'open',
      merged: false,
      head: { sha: 'sha-b' },
      base: { sha: 'sha-c' },
    });
    mockQueue.enqueue = async () => {
      throw new Error('redis down');
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${run.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });

    expect(res.statusCode).toBe(503);
    const all = await store.listReviewRuns('ws-1', 50);
    const created = (all as Array<{ headSha: string; status: string; detail: string | null }>).find(
      (r) => r.headSha === 'sha-b',
    );
    expect(created?.status).toBe('failed');
    expect(created?.detail).toBe('enqueue_failed');
  });

  it('allows retrying skipped run as well', async () => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-skipped',
      pullNumber: 7,
      headSha: 'sha-old',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', run.id, {
      status: 'skipped',
      costUsd: null,
      detail: 'monthly budget reached',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${run.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeDefined();
  });

  it('returns 409 when run status is not failed or skipped (wrong status)', async () => {
    const completedRun = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-comp',
      pullNumber: 1,
      headSha: 'sha-1',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', completedRun.id, {
      status: 'completed',
      costUsd: 0.05,
      detail: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${completedRun.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_status');
  });

  it('returns 409 pr_closed when pull request is closed or merged', async () => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-closed',
      pullNumber: 99,
      headSha: 'sha-1',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', run.id, { status: 'failed', costUsd: null, detail: 'err' });

    mockPrResponses.set('acme/repo-closed#99', {
      state: 'closed',
      merged: true,
      head: { sha: 'sha-1' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${run.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('pr_closed');
  });

  it('returns 409 already_running when an active run already exists for repo+PR+head', async () => {
    const failedRun = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-active',
      pullNumber: 5,
      headSha: 'sha-head-active',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun('ws-1', failedRun.id, { status: 'failed', costUsd: null, detail: 'err' });

    // Create an active (running) run for same repo+PR+head
    await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-active',
      pullNumber: 5,
      headSha: 'sha-head-active',
      status: 'running',
      costUsd: null,
      detail: null,
    });

    mockPrResponses.set('acme/repo-active#5', {
      state: 'open',
      merged: false,
      head: { sha: 'sha-head-active' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-1/runs/${failedRun.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_running');
  });

  it('returns 403 when called by workspace member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/any-run/retry',
      headers: { cookie: signedSessionCookie(TOKEN_MEMBER, config.authSecret) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when run is from another workspace or does not exist', async () => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/repo-test',
      pullNumber: 1,
      headSha: 'sha-1',
      status: 'running',
      costUsd: null,
      detail: null,
    });

    // Calling from ws-2
    const resOther = await app.inject({
      method: 'POST',
      url: `/api/workspaces/ws-2/runs/${run.id}/retry`,
      headers: { cookie: signedSessionCookie(TOKEN_OTHER, config.authSecret) },
    });
    expect(resOther.statusCode).toBe(404);

    // Non-existent id
    const resNonExistent = await app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/runs/00000000-0000-0000-0000-000000000000/retry',
      headers: { cookie: signedSessionCookie(TOKEN_ADMIN, config.authSecret) },
    });
    expect(resNonExistent.statusCode).toBe(404);
  });
});

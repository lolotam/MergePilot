import { Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import * as authSchema from '../auth/schema.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { ReviewJob, ReviewQueue } from '../core/types.js';
import { CredentialService } from '../credentials/service.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import { createServer } from '../server/create-server.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { resetProviderTestRateLimits } from './provider-routes.js';
import { registerDashboardApi } from './routes.js';
import { resetRetryRateLimits } from './runs-retry.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return {
    ...actual,
    listModels: vi.fn(actual.listModels),
    testConnection: vi.fn(actual.testConnection),
  };
});

const { listModels, testConnection } = await import('@mergepilot/engine');

function createCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed) {
          try {
            lines.push(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // ignore non-json
          }
        }
      }
      callback();
    },
  });
  return { stream, lines };
}

describe('Domain events logging - Provider & Runs', () => {
  const workspaceId = 'ws-prov-1';
  const userId = 'u-admin-1';
  const sessionToken = ['tok', 'adm', '2'].join('-');
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let store: PgStore;
  let credentials: CredentialService;
  let enqueued: ReviewJob[];
  let queue: ReviewQueue;
  let cookie: string;

  const mockConfig: AppConfig = {
    baseUrl: 'https://test.mergepilot.com',
    port: 3000,
    databaseUrl: 'memory:',
    redisUrl: 'redis://localhost:6379',
    masterKey: '0'.repeat(32),
    github: {
      appId: '12345',
      privateKey: 'pem',
      webhookSecret: 'sec',
      clientId: 'gh-id',
      clientSecret: 'gh-sec',
      appSlug: 'mergepilot-test',
    },
    google: { clientId: 'g-id', clientSecret: 'g-sec' },
    authSecret: 'x'.repeat(32),
  };

  const githubAppFactory: GitHubAppClientFactory = async () => ({
    client: {
      getPullRequest: async () => ({
        state: 'open',
        merged: false,
        head: { sha: 'sha-head-1' },
        base: { sha: 'sha-base-1' },
      }),
    } as unknown as Awaited<ReturnType<GitHubAppClientFactory>>['client'],
    publisherLogin: 'mergepilot-test[bot]',
  });

  beforeEach(async () => {
    resetRetryRateLimits();
    resetProviderTestRateLimits();
    vi.clearAllMocks();

    pglite = new PGlite();
    await runMigrations(pglite);
    db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
    store = new PgStore(db);
    const vault = new EnvelopeVault(Buffer.alloc(32, 1).toString('base64'));
    credentials = new CredentialService({ store, vault });
    enqueued = [];
    queue = {
      async enqueue(job: ReviewJob) {
        enqueued.push(job);
      },
    };

    await db.insert(authSchema.user).values([
      { id: userId, name: 'Admin', email: 'admin@test.com', emailVerified: true },
    ]);
    await db.insert(authSchema.session).values([
      { id: 'sess-1', token: sessionToken, userId, expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    await db.insert(authSchema.organization).values([
      { id: workspaceId, name: 'Prov WS', slug: 'prov-ws' },
    ]);
    await db.insert(authSchema.member).values([
      { id: 'm-1', organizationId: workspaceId, userId, role: 'owner' },
    ]);

    await store.saveSettings({
      workspaceId,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      language: 'en',
      monthlyBudgetUsd: null,
    });

    await store.upsertInstallation({
      id: 100,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });

    cookie = signedSessionCookie(sessionToken, mockConfig.authSecret);
  }, 30000);

  afterEach(async () => {
    await pglite.close();
  });

  function setupApp(logger: import('pino').Logger) {
    const auth = createAuth({ db, config: mockConfig });
    return createServer({
      config: mockConfig,
      store,
      queue,
      log: logger,
      extraRoutes: (instance) => {
        registerAuthRoutes(instance, auth);
        registerDashboardApi(instance, {
          auth,
          store,
          credentials,
          config: mockConfig,
          queue,
          githubAppFactory,
          validateKey: vi.fn().mockResolvedValue(undefined),
        });
      },
    });
  }

  it('logs provider model listing (fresh and cached) and connection test events', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    await credentials.saveKey({
      workspaceId,
      provider: 'anthropic',
      apiKey: ['tk', 'ant', '123'].join('-'),
      userId,
    });

    vi.mocked(listModels).mockResolvedValue([{ id: 'm-1', name: 'Model 1', efforts: [] }]);

    // 1. Fresh model listing
    const resFresh = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/providers/anthropic/models`,
      headers: { cookie },
    });
    expect(resFresh.statusCode).toBe(200);

    const freshLog = lines.find((l) => l.event === 'provider.models_listed' && l.cached === false);
    expect(freshLog).toBeDefined();
    expect(freshLog?.provider).toBe('anthropic');
    expect(freshLog?.ok).toBe(true);
    expect(freshLog?.count).toBe(1);

    // 2. Cached model listing
    const resCached = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/providers/anthropic/models`,
      headers: { cookie },
    });
    expect(resCached.statusCode).toBe(200);

    const cachedLog = lines.find((l) => l.event === 'provider.models_listed' && l.cached === true);
    expect(cachedLog).toBeDefined();
    expect(cachedLog?.provider).toBe('anthropic');
    expect(cachedLog?.ok).toBe(true);

    // 3. Connection test
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 50, model: 'claude-3-5-sonnet' });

    const resTest = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/credentials/anthropic/test`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-3-5-sonnet' }),
    });
    expect(resTest.statusCode).toBe(200);

    const testLog = lines.find((l) => l.event === 'provider.test_connection');
    expect(testLog).toBeDefined();
    expect(testLog?.provider).toBe('anthropic');
    expect(testLog?.model).toBe('claude-3-5-sonnet');
    expect(testLog?.ok).toBe(true);
    expect(testLog?.ms).toBe(50);
  });

  it('logs runs retry and retry-all events', async () => {
    const { stream, lines } = createCapture();
    const logger = createLogger({ service: 'web', stream });
    const app = setupApp(logger);

    const run = await store.createReviewRun({
      workspaceId,
      installationId: 100,
      repoFullName: 'acme/repo',
      pullNumber: 1,
      headSha: 'sha-old',
      status: 'running',
      costUsd: null,
      detail: null,
    });
    await store.finishReviewRun(workspaceId, run.id, { status: 'failed', costUsd: null, detail: 'err' });

    // 1. Single retry
    const resSingle = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/runs/${run.id}/retry`,
      headers: { cookie },
    });
    expect(resSingle.statusCode).toBe(202);

    const retryLog = lines.find((l) => l.event === 'runs.retry');
    expect(retryLog).toBeDefined();
    expect(retryLog?.workspaceId).toBe(workspaceId);
    expect(retryLog?.retriedCount).toBe(1);

    // 2. Retry all (preview / dry run)
    const resDry = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/runs/retry-failed`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ dryRun: true }),
    });
    expect(resDry.statusCode).toBe(200);

    const dryLog = lines.find((l) => l.event === 'runs.retry_all' && l.dryRun === true);
    expect(dryLog).toBeDefined();
    expect(dryLog?.workspaceId).toBe(workspaceId);
    expect(typeof dryLog?.wouldQueueCount).toBe('number');

    // 3. Retry all (real)
    const resReal = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/runs/retry-failed`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ dryRun: false }),
    });
    expect(resReal.statusCode).toBe(200);

    const realLog = lines.find((l) => l.event === 'runs.retry_all' && l.dryRun === false);
    expect(realLog).toBeDefined();
    expect(realLog?.workspaceId).toBe(workspaceId);
    expect(typeof realLog?.queuedCount).toBe('number');
  });
});

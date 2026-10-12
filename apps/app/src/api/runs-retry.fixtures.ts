import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import * as authSchema from '../auth/schema.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import type { NewReviewRun, ReviewJob, ReviewQueue, ReviewRun } from '../core/types.js';
import { CredentialService } from '../credentials/service.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import type { GitHubAppClientFactory } from '../worker/types.js';
import { registerDashboardApi } from './routes.js';
import { resetRetryRateLimits } from './runs-retry.js';

// Test-only harness for the retry endpoints (excluded from the build).

type GitHubClientLike = Awaited<ReturnType<GitHubAppClientFactory>>['client'];
type PullRequest = Awaited<ReturnType<GitHubClientLike['getPullRequest']>>;

export interface FakePr {
  state?: string;
  merged?: boolean;
  head: { sha: string };
  base?: { sha: string };
}

export interface RetryHarness {
  app: FastifyInstance;
  store: PgStore;
  db: PgliteDatabase<typeof authSchema & typeof dbSchema>;
  enqueued: ReviewJob[];
  /** `owner/repo#n` -> PR; unset PRs are open with head `sha-current-head`. */
  prs: Map<string, FakePr>;
  adminCookie: string;
  /** A finished run with the given status (default failed) for ws-1, installation 100. */
  seedRun: (overrides: Partial<NewReviewRun>, finalStatus?: 'failed' | 'completed') => Promise<ReviewRun>;
  close: () => Promise<void>;
}

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

export async function createRetryHarness(): Promise<RetryHarness> {
  resetRetryRateLimits();
  const enqueued: ReviewJob[] = [];
  const queue: ReviewQueue = {
    async enqueue(job: ReviewJob) {
      enqueued.push(job);
    },
  };
  const prs = new Map<string, FakePr>();
  const githubAppFactory: GitHubAppClientFactory = async () => ({
    client: {
      async getPullRequest(params: { owner: string; repo: string; pull_number: number }) {
        const pr = prs.get(`${params.owner}/${params.repo}#${params.pull_number}`) ?? {
          state: 'open',
          merged: false,
          head: { sha: 'sha-current-head' },
          base: { sha: 'sha-base-1' },
        };
        return pr as unknown as PullRequest;
      },
    } as unknown as GitHubClientLike,
    publisherLogin: 'mergepilot-test[bot]',
  });

  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
  const store = new PgStore(db);
  const vault = new EnvelopeVault(Buffer.alloc(32, 1).toString('base64'));
  const credentials = new CredentialService({ store, vault });
  const auth = createAuth({ db, config });

  const app = fastify();
  registerAuthRoutes(app, auth);
  registerDashboardApi(app, { auth, store, credentials, config, queue, githubAppFactory });

  const token = ['t', 'adm'].join('-');
  await db.insert(authSchema.user).values([
    { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
  ]);
  await db.insert(authSchema.session).values([
    { id: 's-admin', token, userId: 'u-admin', expiresAt: new Date(Date.now() + 86_400_000) },
  ]);
  await db.insert(authSchema.organization).values([{ id: 'ws-1', name: 'W1', slug: 'w1' }]);
  await db
    .insert(authSchema.member)
    .values([{ id: 'm-1', organizationId: 'ws-1', userId: 'u-admin', role: 'admin' }]);
  await store.upsertInstallation({
    id: 100,
    workspaceId: 'ws-1',
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspended: false,
  });
  await app.ready();

  const seedRun: RetryHarness['seedRun'] = async (overrides, finalStatus = 'failed') => {
    const run = await store.createReviewRun({
      workspaceId: 'ws-1',
      installationId: 100,
      repoFullName: 'acme/app',
      pullNumber: 1,
      headSha: 'sha-old',
      status: 'running',
      costUsd: null,
      detail: null,
      ...overrides,
    });
    await store.finishReviewRun('ws-1', run.id, { status: finalStatus, costUsd: null, detail: 'x' });
    return run;
  };

  return {
    app,
    store,
    db,
    enqueued,
    prs,
    adminCookie: signedSessionCookie(token, config.authSecret),
    seedRun,
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

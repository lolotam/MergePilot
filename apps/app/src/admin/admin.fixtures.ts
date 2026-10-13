import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import * as authSchema from '../auth/schema.js';
import { registerAdminApi } from './routes.js';

// Test-only helpers for the platform admin tests (excluded from the build).

export interface AdminTestDb {
  db: PgliteDatabase<typeof dbSchema>;
  store: PgStore;
  close: () => Promise<void>;
}

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

/** In-memory Postgres with the app + auth migrations applied directly (fast, no lock). */
export async function createAdminTestDb(): Promise<AdminTestDb> {
  const client = new PGlite();
  for (const file of [
    '0001_app.sql',
    '0002_auth.sql',
    '0003_review_run_details.sql',
    '0004_active_run_unique.sql',
    '0005_settings_models.sql',
    '0006_run_retention.sql',
    '0007_judge.sql',
    '0009_reviewer_panel.sql',
  ]) {
    await client.exec(readFileSync(join(migrationsDir, file), 'utf-8'));
  }
  const db = drizzle(client, { schema: dbSchema });
  return { db, store: new PgStore(db), close: () => client.close() };
}

/**
 * Fixture-only values are built at runtime and kept short so they never look like real secrets
 * to a scanner. They are meaningless outside these tests.
 */
export function fixtureToken(id: string): string {
  return `t-${id}`;
}

/** A distinctive marker stored in a secret column; tests assert it never reaches a response. */
export function neverLeakValue(kind: string): string {
  return `fixture-${kind}-value-never-leak`;
}

/** Fake provider-credential ciphertext; tests assert it never reaches a response. */
export function fakeCiphertext(provider: string): string {
  return `vault:secret-ciphertext-${provider}`;
}

export function adminTestConfig(platformAdmins: string[]): AppConfig {
  return {
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
    platformAdmins,
  };
}

/**
 * Seeds: verified admin `u-admin` (session `fixtureToken('admin')`), regular `u-regular` (session
 * `fixtureToken('regular')`,
 * github + google accounts with fake tokens), workspaces ws-1 and ws-2 both owned by u-regular,
 * provider credentials with fake ciphertext, settings, installations 101/102 linked + 103 pending,
 * and three review runs (two in ws-1, one in ws-2).
 */
export async function seedAdminFixtures(db: AdminTestDb['db']): Promise<void> {
  // Seed admin user
  await db.insert(authSchema.user).values({
    id: 'u-admin',
    name: 'Admin User',
    email: 'admin@mergepilot.com',
    emailVerified: true,
  });
  await db.insert(authSchema.session).values({
    id: 's-admin',
    token: fixtureToken('admin'),
    userId: 'u-admin',
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date('2026-10-10T10:00:00.000Z'),
  });

  // Seed regular user
  await db.insert(authSchema.user).values({
    id: 'u-regular',
    name: 'Regular User',
    email: 'user@example.com',
    emailVerified: true,
  });
  await db.insert(authSchema.session).values({
    id: 's-regular',
    token: fixtureToken('regular'),
    userId: 'u-regular',
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date('2026-10-11T12:00:00.000Z'),
  });
  await db.insert(authSchema.account).values([
    {
      id: 'acc-github',
      userId: 'u-regular',
      accountId: 'gh-123',
      providerId: 'github',
      accessToken: neverLeakValue('access'),
      refreshToken: neverLeakValue('refresh'),
    },
    {
      id: 'acc-google',
      userId: 'u-regular',
      accountId: 'goog-456',
      providerId: 'google',
      idToken: neverLeakValue('id'),
    },
  ]);

  // Seed workspaces: ws-1 (owned by u-regular), ws-2 (no members, orphan candidate)
  await db.insert(authSchema.organization).values([
    { id: 'ws-1', name: 'Acme Corp', slug: 'acme-corp' },
    { id: 'ws-2', name: 'Solo Project', slug: 'solo-project' },
  ]);

  await db.insert(authSchema.member).values([
    { id: 'm-1', organizationId: 'ws-1', userId: 'u-regular', role: 'owner' },
    { id: 'm-2', organizationId: 'ws-2', userId: 'u-regular', role: 'owner' },
  ]);

  // Seed provider credentials with ciphertext
  await db.insert(dbSchema.providerCredentials).values([
    {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'ws-1',
      provider: 'anthropic',
      ciphertext: fakeCiphertext('anthropic'),
      keyVersion: 1,
      last4: '1234',
      createdBy: 'u-regular',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'ws-2',
      provider: 'openai',
      ciphertext: fakeCiphertext('openai'),
      keyVersion: 1,
      last4: '5678',
      createdBy: 'u-regular',
    },
  ]);

  // Seed workspace settings
  await db.insert(dbSchema.workspaceSettings).values([
    { workspaceId: 'ws-1', provider: 'anthropic', model: 'claude-3-5-sonnet', language: 'en', monthlyBudgetUsd: '100' },
    { workspaceId: 'ws-2', provider: 'openai', model: 'gpt-4o', language: 'ar', monthlyBudgetUsd: '50' },
  ]);

  // Seed installations: 1 linked to ws-1, 1 linked to ws-2, 1 pending unlinked
  await db.insert(dbSchema.installations).values([
    { id: 101, workspaceId: 'ws-1', accountLogin: 'acme-org', accountType: 'Organization', repositorySelection: 'all', suspended: false },
    { id: 102, workspaceId: 'ws-2', accountLogin: 'solo-dev', accountType: 'User', repositorySelection: 'selected', suspended: false },
    { id: 103, workspaceId: null, accountLogin: 'pending-dev', accountType: 'User', repositorySelection: 'all', suspended: false },
  ]);

  // Seed review runs
  await db.insert(dbSchema.reviewRuns).values([
    {
      id: '33333333-3333-4333-8333-333333333333',
      workspaceId: 'ws-1',
      installationId: 101,
      repoFullName: 'acme/backend',
      pullNumber: 10,
      headSha: 'sha10',
      status: 'completed',
      costUsd: '0.150000',
      createdAt: new Date(),
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: 'ws-1',
      installationId: 101,
      repoFullName: 'acme/frontend',
      pullNumber: 12,
      headSha: 'sha12',
      status: 'failed',
      costUsd: '0.050000',
      createdAt: new Date(),
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      workspaceId: 'ws-2',
      installationId: 102,
      repoFullName: 'solo/app',
      pullNumber: 1,
      headSha: 'sha1',
      status: 'queued',
      costUsd: null,
      createdAt: new Date(),
    },
  ]);

  // The finished runs above, as the worker would have added them to the monthly usage summary.
  const month = `${new Date().toISOString().slice(0, 7)}-01`;
  await db.insert(dbSchema.workspaceUsageMonthly).values({
    workspaceId: 'ws-1',
    month,
    runsTotal: 2,
    runsCompleted: 1,
    runsFailed: 1,
    costUsd: '0.200000',
  });
}

export interface SeededAdminApp {
  app: FastifyInstance;
  handle: AdminTestDb;
  /** Session cookie for the seeded platform admin `u-admin`. */
  adminCookie: string;
}

/** A Fastify app with auth + admin API over a fresh seeded database. Close app and handle after. */
export async function createSeededAdminApp(): Promise<SeededAdminApp> {
  const config = adminTestConfig(['admin@mergepilot.com']);
  const handle = await createAdminTestDb();
  const auth = createAuth({ db: handle.db, config });
  const app = fastify();
  registerAuthRoutes(app, auth);
  registerAdminApi(app, { auth, db: handle.db, config, store: handle.store });
  await seedAdminFixtures(handle.db);
  await app.ready();
  return { app, handle, adminCookie: signedSessionCookie(fixtureToken('admin'), config.authSecret) };
}

import { Writable } from 'node:stream';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createAuth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { DnsLookupFn } from '../core/ssrf.js';
import { CredentialService } from '../credentials/service.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { resetProviderTestRateLimits } from './provider-routes.js';
import { registerDashboardApi } from './routes.js';

/** Obvious fake keys and passphrases built at runtime: no secret-looking literal sits in the tests. */
export const fakeKey = (tag: string): string => ['fake', tag, 'key', 'q7'.repeat(6)].join('-');
export const PASSPHRASE = ['owner', 'backup', 'phrase', '2026'].join('-');

const filler = (length: number): string => 'x'.repeat(length);
const config: AppConfig = {
  baseUrl: 'http://localhost:3000',
  port: 3000,
  databaseUrl: 'postgres://localhost:5432/test',
  redisUrl: 'redis://localhost:6379',
  masterKey: filler(32),
  github: { appId: '1', privateKey: 'pem', webhookSecret: 'whk', clientId: 'gh-id', clientSecret: 'ghc', appSlug: 'mp-test' },
  google: { clientId: 'g-id', clientSecret: 'ggc' },
  authSecret: filler(40),
};

export type Who = 'owner' | 'admin' | 'member';

export interface BackupHarness {
  app: FastifyInstance;
  store: PgStore;
  credentials: CredentialService;
  /** Every log line the server wrote, raw. */
  logText: () => string;
  logLines: () => Array<Record<string, unknown>>;
  cookie: (who: Who) => string;
  /** Answers every DNS lookup; set a private address to simulate a forbidden host. */
  dns: { address: string };
  close: () => Promise<void>;
}

/**
 * Fastify + PGlite with three workspaces: `ws-1` (owner, admin, member), `ws-2` (same owner, a fresh
 * copy target) and `ws-3` (another owner). DNS is faked; the key check never calls out.
 */
export async function createBackupHarness(): Promise<BackupHarness> {
  resetProviderTestRateLimits();
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
  const store = new PgStore(db);
  const dns = { address: '93.184.216.34' };
  const ssrfLookup: DnsLookupFn = async () => [{ address: dns.address, family: 4 }];
  const credentials = new CredentialService({ store, vault: new EnvelopeVault(Buffer.alloc(32, 7).toString('base64')), ssrfLookup });

  let raw = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      raw += chunk.toString();
      callback();
    },
  });
  const app = fastify({ loggerInstance: createLogger({ stream, level: 'debug' }) });
  const auth = createAuth({ db, config });
  registerAuthRoutes(app, auth);
  registerDashboardApi(app, {
    auth,
    store,
    credentials,
    config,
    ssrfLookup,
    validateKey: async () => undefined,
    now: () => new Date('2026-10-13T08:00:00Z'),
  });

  await db.insert(authSchema.user).values([
    { id: 'u-owner', name: 'Owner', email: 'owner@test.com', emailVerified: true },
    { id: 'u-admin', name: 'Admin', email: 'admin@test.com', emailVerified: true },
    { id: 'u-member', name: 'Member', email: 'member@test.com', emailVerified: true },
  ]);
  const expiresAt = new Date(Date.now() + 86400000);
  await db.insert(authSchema.session).values([
    { id: 's-owner', token: 't-own', userId: 'u-owner', expiresAt },
    { id: 's-admin', token: 't-adm', userId: 'u-admin', expiresAt },
    { id: 's-member', token: 't-mem', userId: 'u-member', expiresAt },
  ]);
  await db.insert(authSchema.organization).values([
    { id: 'ws-1', name: 'Team One', slug: 'team-one' },
    { id: 'ws-2', name: 'Team Two', slug: 'team-two' },
    { id: 'ws-3', name: 'Someone else', slug: 'someone-else' },
  ]);
  await db.insert(authSchema.member).values([
    { id: 'm-1-owner', organizationId: 'ws-1', userId: 'u-owner', role: 'owner' },
    { id: 'm-1-admin', organizationId: 'ws-1', userId: 'u-admin', role: 'admin' },
    { id: 'm-1-member', organizationId: 'ws-1', userId: 'u-member', role: 'member' },
    { id: 'm-2-owner', organizationId: 'ws-2', userId: 'u-owner', role: 'owner' },
    { id: 'm-3-owner', organizationId: 'ws-3', userId: 'u-admin', role: 'owner' },
  ]);
  await app.ready();

  const tokens: Record<Who, string> = { owner: 't-own', admin: 't-adm', member: 't-mem' };
  return {
    app,
    store,
    credentials,
    logText: () => raw,
    logLines: () =>
      raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cookie: (who) => signedSessionCookie(tokens[who], config.authSecret),
    dns,
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

/** Fills `ws-1` with settings, two extra bots and keys (a custom one with its base URL). */
export async function seedWorkspace(h: BackupHarness): Promise<void> {
  const save = (provider: Parameters<CredentialService['saveKey']>[0]['provider'], baseUrl?: string) =>
    h.credentials.saveKey({ workspaceId: 'ws-1', provider, apiKey: fakeKey(provider), userId: 'u-owner', baseUrl });
  await save('anthropic');
  await save('openrouter');
  await save('typesafe');
  await save('custom', 'https://llm.example.com/v1');
  const put = async (url: string, payload: Record<string, unknown>) => {
    const res = await h.app.inject({ method: 'PUT', url, headers: { cookie: h.cookie('owner') }, payload });
    if (res.statusCode !== 200) throw new Error(`seed ${url} failed: ${res.body}`);
  };
  await put('/api/workspaces/ws-1/settings', {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    language: 'ar',
    monthlyBudgetUsd: 40,
    effort: 'high',
    heavyProvider: 'openrouter',
    heavyModel: 'openai/gpt-5',
    heavyThresholdLines: 1200,
    fallback: [{ provider: 'custom', model: 'my-model' }],
    minSeverity: 'high',
    runRetentionDays: 90,
    repoColors: { 'acme/api': 'sky' },
    judge: { enabled: true, provider: 'typesafe', model: 'jev-latest', mode: 'filter', threshold: 0.4, fallback: [] },
    botName: 'Pilot Prime',
    botLogo: 'rocket',
    panelMode: 'consensus',
    panelMinAgreement: 2,
  });
  await put('/api/workspaces/ws-1/bots/2', { name: 'Owl', logo: 'owl', provider: 'openrouter', model: 'openai/gpt-5', fallback: [] });
  await put('/api/workspaces/ws-1/bots/4', {
    name: 'Fox',
    logo: 'fox',
    active: false,
    provider: 'anthropic',
    model: 'claude-haiku-5',
    effort: 'low',
    fallback: [{ provider: 'openrouter', model: 'openai/gpt-5-mini' }],
  });
}

export function exportBackup(h: BackupHarness, body: Record<string, unknown>, who: Who = 'owner', ws = 'ws-1') {
  return h.app.inject({ method: 'POST', url: `/api/workspaces/${ws}/backup/export`, headers: { cookie: h.cookie(who) }, payload: body });
}

export function restoreBackup(h: BackupHarness, body: Record<string, unknown>, who: Who = 'owner', ws = 'ws-2') {
  return h.app.inject({ method: 'POST', url: `/api/workspaces/${ws}/backup/restore`, headers: { cookie: h.cookie(who) }, payload: body });
}

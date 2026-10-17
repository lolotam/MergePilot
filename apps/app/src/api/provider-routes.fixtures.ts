import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { FetchLike, SubscriptionProvider } from '@mergepilot/engine';
import { createAuth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import type { DnsLookupFn } from '../core/ssrf.js';
import { CredentialService } from '../credentials/service.js';
import type { SubscriptionLoginFn } from '../credentials/subscription-login.js';
import { runMigrations } from '../db/migrate.js';
import { PgStore } from '../db/pg-store.js';
import * as dbSchema from '../db/schema.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { resetProviderTestRateLimits } from './provider-routes.js';
import { registerDashboardApi } from './routes.js';

/** A provider key built at runtime, so no secret-looking literal sits in the tests. */
export const keyFor = (tag: string): string => ['tk', tag, 'z8'.repeat(6)].join('-');

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

export interface ProviderHarness {
  app: FastifyInstance;
  credentials: CredentialService;
  store: PgStore;
  /** Adds a workspace with `u-admin` as its admin (and no member). */
  addWorkspace: (id: string) => Promise<void>;
  adminCookie: () => string;
  memberCookie: () => string;
  /** The addresses the fake DNS answers with; change it to simulate DNS rebinding. */
  dns: { address: string };
  close: () => Promise<void>;
}

/** Fastify + PGlite with an admin and a member in workspace `ws-1`; DNS and custom fetch faked. */
export async function createProviderHarness(
  customFetch?: FetchLike,
  subscriptionLogin?: SubscriptionLoginFn,
  subscriptionAvailable?: (provider: SubscriptionProvider) => boolean,
): Promise<ProviderHarness> {
  resetProviderTestRateLimits();
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
  const store = new PgStore(db);
  const dns = { address: '93.184.216.34' };
  const ssrfLookup: DnsLookupFn = async () => [{ address: dns.address, family: 4 }];
  const credentials = new CredentialService({
    store,
    vault: new EnvelopeVault(Buffer.alloc(32, 1).toString('base64')),
    ssrfLookup,
  });
  const auth = createAuth({ db, config });
  const app = fastify();
  registerAuthRoutes(app, auth);
  registerDashboardApi(app, {
    auth,
    store,
    credentials,
    config,
    ssrfLookup,
    validateKey: async () => undefined,
    ...(subscriptionLogin ? { subscriptionLogin } : {}),
    ...(subscriptionAvailable ? { subscriptionAvailable } : {}),
    ...(customFetch ? { customFetch } : {}),
  });

  await db.insert(authSchema.user).values([
    { id: 'u-admin', name: 'Admin User', email: 'admin@test.com', emailVerified: true },
    { id: 'u-member', name: 'Member User', email: 'member@test.com', emailVerified: true },
  ]);
  const expiresAt = new Date(Date.now() + 86400000);
  await db.insert(authSchema.session).values([
    { id: 's-admin', token: 't-adm', userId: 'u-admin', expiresAt },
    { id: 's-member', token: 't-mem', userId: 'u-member', expiresAt },
  ]);
  await db.insert(authSchema.organization).values([{ id: 'ws-1', name: 'Workspace 1', slug: 'workspace-1' }]);
  await db.insert(authSchema.member).values([
    { id: 'm-admin', organizationId: 'ws-1', userId: 'u-admin', role: 'admin' },
    { id: 'm-member', organizationId: 'ws-1', userId: 'u-member', role: 'member' },
  ]);
  await app.ready();

  return {
    app,
    credentials,
    store,
    addWorkspace: async (id) => {
      await db.insert(authSchema.organization).values([{ id, name: `Workspace ${id}`, slug: id }]);
      await db.insert(authSchema.member).values([{ id: `m-admin-${id}`, organizationId: id, userId: 'u-admin', role: 'admin' }]);
    },
    adminCookie: () => signedSessionCookie('t-adm', config.authSecret),
    memberCookie: () => signedSessionCookie('t-mem', config.authSecret),
    dns,
    close: async () => {
      await app.close();
      await pglite.close();
    },
  };
}

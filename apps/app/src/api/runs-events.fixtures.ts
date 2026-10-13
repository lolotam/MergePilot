import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createAuth, type Auth } from '../auth/auth.js';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import { runMigrations } from '../db/migrate.js';
import type { AppConfig } from '../core/config.js';

// Session tokens built at runtime so no secret-looking literal sits in the test.
export const TOKEN_MEMBER = ['t', 'sse', 'm'].join('-');
export const TOKEN_OTHER = ['t', 'sse', 'o'].join('-');

export const sseConfig: AppConfig = {
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

export const cookieFor = (token: string) => signedSessionCookie(token, sseConfig.authSecret);

export interface SseHarness {
  app: FastifyInstance;
  auth: Auth;
  db: ReturnType<typeof drizzle>;
  pglite: PGlite;
}

/** Two users: `u-member` belongs to ws-1, `u-other` to ws-2. Routes are added by the caller. */
export async function createSseHarness(): Promise<SseHarness> {
  const pglite = new PGlite();
  await runMigrations(pglite);
  const db = drizzle(pglite, { schema: { ...authSchema, ...dbSchema } });
  const auth = createAuth({ db, config: sseConfig });
  const app = fastify();
  registerAuthRoutes(app, auth);

  await db.insert(authSchema.user).values([
    { id: 'u-member', name: 'Member', email: 'member@test.com', emailVerified: true },
    { id: 'u-other', name: 'Other', email: 'other@test.com', emailVerified: true },
  ]);
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.insert(authSchema.session).values([
    { id: 's-member', token: TOKEN_MEMBER, userId: 'u-member', expiresAt },
    { id: 's-other', token: TOKEN_OTHER, userId: 'u-other', expiresAt },
  ]);
  await db.insert(authSchema.organization).values([
    { id: 'ws-1', name: 'Workspace 1', slug: 'workspace-1' },
    { id: 'ws-2', name: 'Workspace 2', slug: 'workspace-2' },
  ]);
  await db.insert(authSchema.member).values([
    { id: 'm-1', organizationId: 'ws-1', userId: 'u-member', role: 'member' },
    { id: 'm-2', organizationId: 'ws-2', userId: 'u-other', role: 'member' },
  ]);
  return { app, auth, db, pglite };
}

export async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

export interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far. */
  text: () => string;
  /** Resolves once the received text satisfies `predicate`. */
  waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
}

/** Opens a real SSE connection (inject cannot read a stream that never ends). */
export function openStream(port: number, workspaceId: string, cookie: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: `/api/workspaces/${workspaceId}/runs/events`, headers: { cookie, accept: 'text/event-stream' } },
      (res) => {
        let received = '';
        const waiters: Array<() => void> = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
          for (const w of [...waiters]) w();
        });
        res.on('error', () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => received,
          waitFor: (predicate, timeoutMs = 3_000) =>
            new Promise((ok, fail) => {
              const check = () => {
                if (!predicate(received)) return;
                clearTimeout(timer);
                waiters.splice(waiters.indexOf(check), 1);
                ok(received);
              };
              const timer = setTimeout(() => fail(new Error(`stream timed out; got: ${received}`)), timeoutMs);
              waiters.push(check);
              check();
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
  });
}

/** Polls until `check` passes (server-side cleanup happens on the socket's close event). */
export async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

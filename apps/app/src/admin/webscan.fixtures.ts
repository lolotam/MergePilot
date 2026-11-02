import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from '../auth/auth.js';
import { registerAuthRoutes } from '../auth/fastify.js';
import * as authSchema from '../auth/schema.js';
import { signedSessionCookie } from '../auth/session-cookie.fixtures.js';
import type { AppConfig } from '../core/config.js';
import { PurposeScopedVault } from '../vault/scoped-secrets.js';
import { MemoryWebScanEventBus } from '../webscan/events.js';
import type { WebScanEventBus } from '../webscan/events.js';
import { PgWebScanStore } from '../webscan/pg-store.js';
import { registerAdminApi } from './routes.js';
import {
  adminTestConfig,
  createAdminTestDb,
  fixtureToken,
  seedAdminFixtures,
  type AdminTestDb,
} from './admin.fixtures.js';

/**
 * The shared harness of the scanner route tests (ADR-0052 Task 8B).
 *
 * The app is the real one: the real guard, the real admin routes, the real store
 * over a real PGlite database and the real in-memory event bus. Only the Redis bus
 * is left out, because it is a transport and not a boundary of the behaviour.
 *
 * The harness seeds four callers, so the access tests can prove that every method
 * answers the same 404 to each of them:
 *
 * - `u-admin`: a verified platform administrator;
 * - `u-unverified`: an address of the administrator list whose email is not verified;
 * - `u-wsadmin`: an administrator of a workspace, but not a platform administrator;
 * - `u-regular`: a member of another workspace, with no role in the platform area.
 */

export const ADMIN_EMAIL = 'admin@mergepilot.com';
export const UNVERIFIED_ADMIN_EMAIL = 'unverified@mergepilot.com';

export interface WebScanAdminHarness {
  app: FastifyInstance;
  handle: AdminTestDb;
  store: PgWebScanStore;
  events: MemoryWebScanEventBus;
  config: AppConfig;
  /** Every log line the app wrote, so a test can prove what never reached a log. */
  logs: string[];
  /** The cookie of the platform administrator `u-admin`. */
  adminCookie: string;
  /** The cookie of a caller whose email is not verified. */
  unverifiedCookie: string;
  /** The cookie of a workspace administrator who is not a platform administrator. */
  workspaceAdminCookie: string;
  /** The cookie of a member of another workspace. */
  regularCookie: string;
}

export interface WebScanHarnessOptions {
  /** The limits of the live scan streams. */
  streams?:
    | { perUser?: number; global?: number; keepAliveMs?: number; maxLifetimeMs?: number }
    | undefined;
  /**
   * The event bus fails to subscribe.
   *
   * The live progress route answers 503 when the bus cannot be reached, and this is
   * the only way to reach that branch without a broken Redis.
   */
  failingEvents?: boolean | undefined;
}

/** Builds the admin app with the scanner over a fresh seeded database. */
export async function createWebScanAdminApp(
  options: WebScanHarnessOptions = {},
): Promise<WebScanAdminHarness> {
  const config = adminTestConfig([ADMIN_EMAIL, UNVERIFIED_ADMIN_EMAIL]);
  const handle = await createAdminTestDb();
  const auth = createAuth({ db: handle.db, config });
  const logs: string[] = [];
  const app = fastify({ logger: { level: 'info', stream: logStream(logs) } });
  registerAuthRoutes(app, auth);

  const events = new MemoryWebScanEventBus();
  const bus: WebScanEventBus =
    options.failingEvents === true
      ? {
          publish: (event) => events.publish(event),
          subscribe: async () => {
            throw new Error('the event bus is not available');
          },
          close: async () => events.close(),
        }
      : events;
  const store = new PgWebScanStore(
    handle.db,
    new PurposeScopedVault({ masterKey: randomBytes(32).toString('base64') }),
  );
  registerAdminApi(app, {
    auth,
    db: handle.db,
    config,
    webScan: { store, events: bus, streams: options.streams },
  });
  await seedAdminFixtures(handle.db);
  await seedExtraCallers(handle.db);
  await app.ready();

  return {
    app,
    handle,
    store,
    events,
    config,
    logs,
    adminCookie: signedSessionCookie(fixtureToken('admin'), config.authSecret),
    unverifiedCookie: signedSessionCookie(fixtureToken('unverified'), config.authSecret),
    workspaceAdminCookie: signedSessionCookie(fixtureToken('wsadmin'), config.authSecret),
    regularCookie: signedSessionCookie(fixtureToken('regular'), config.authSecret),
  };
}

/** A log stream that keeps every line instead of printing it. */
function logStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
}

/**
 * The two callers the admin fixtures do not seed: one whose email is not verified and
 * one who administers a workspace without being a platform administrator.
 */
async function seedExtraCallers(db: AdminTestDb['db']): Promise<void> {
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.insert(authSchema.user).values([
    {
      id: 'u-unverified',
      name: 'Unverified Admin',
      email: UNVERIFIED_ADMIN_EMAIL,
      emailVerified: false,
    },
    {
      id: 'u-wsadmin',
      name: 'Workspace Admin',
      email: 'wsadmin@example.com',
      emailVerified: true,
    },
  ]);
  await db.insert(authSchema.session).values([
    {
      id: 's-unverified',
      token: fixtureToken('unverified'),
      userId: 'u-unverified',
      expiresAt,
    },
    {
      id: 's-wsadmin',
      token: fixtureToken('wsadmin'),
      userId: 'u-wsadmin',
      expiresAt,
    },
  ]);
  await db.insert(authSchema.member).values([
    { id: 'm-3', organizationId: 'ws-1', userId: 'u-wsadmin', role: 'admin' },
  ]);
}

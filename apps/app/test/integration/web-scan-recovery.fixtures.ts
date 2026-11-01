import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CheckSwitches, ScanLimits } from '@mergepilot/webscan';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createQueueConnection } from '../../src/queue/bullmq-queue.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { defaultScope } from '../../src/webscan/pg-rows.js';
import { PgWebScanWorkerStore } from '../../src/webscan/worker-store-persistence.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  createMigratedTestDb,
  INTEGRATION_DATABASE_URL,
  INTEGRATION_REDIS_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The fixtures of the crash and recovery proof.
 *
 * Every fixture here is real: a migrated schema on the dedicated Postgres of this wave, a
 * real BullMQ queue on the dedicated Redis of this wave, and the production store, worker
 * store, dispatcher and lease of the app. The only thing that is replaced is the network
 * of the scanner: the fixture transport answers instead of the guarded HTTP client, so no
 * request ever leaves the machine.
 */

/** The master key of the vault of the fixtures. It is a test key, not a secret. */
export const RECOVERY_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

/** The platform administrators of the fixtures. */
export const RECOVERY_PLATFORM_ADMINS = ['admin@example.com'];

/** The page the fixture transport serves. It links to a second page of the same site. */
export const RECOVERY_PAGE_WITH_LINK =
  '<!doctype html><html><head><title>fixture</title></head>' +
  '<body><p>fixture</p><a href="/second">second</a></body></html>';

/** The page the fixture transport serves when no link is needed. */
export const RECOVERY_PAGE =
  '<!doctype html><html><head><title>fixture</title></head><body><p>fixture</p></body></html>';

/** The rule of a crawl path. */
export interface RecoveryPathRule {
  path: string;
  kind: 'exact' | 'prefix';
}

/** The options of {@link createRecoveryFixture}. */
export interface RecoveryFixtureOptions {
  /** The hostname of the site. Two sites of one schema need two hostnames. */
  hostname?: string;
  /** The crawl rules of the site. Empty by default, so the crawl follows no link. */
  crawlPaths?: readonly RecoveryPathRule[];
  /** The idempotency key of the manual scan. */
  idempotencyKey?: string;
  /** The checks of the settings row. Only the header and the cookie check by default. */
  checks?: CheckSwitches;
  /** The limits of the settings row. */
  limits?: Partial<ScanLimits>;
}

/** One fixture of the proof. */
export interface RecoveryFixture {
  /** The migrated schema of the fixture. */
  context: TestPostgresContext;
  /** The production store over the schema. */
  store: PgWebScanStore;
  /** The production worker store over the schema. */
  workerStore: PgWebScanWorkerStore;
  /** The id of the site. */
  siteId: string;
  /** The id of the queued scan. */
  scanId: string;
  /** The connection string of the schema, for the child processes. */
  connectionString: string;
}

/**
 * Creates a fixture: a migrated schema, the administrator, the settings, the site and one
 * queued scan whose intent is committed to the database and not published to Redis yet.
 */
export async function createRecoveryFixture(
  options: RecoveryFixtureOptions = {},
): Promise<RecoveryFixture> {
  const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
  await context.pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`,
    ['admin-1', 'Admin', RECOVERY_PLATFORM_ADMINS[0]],
  );
  const store = new PgWebScanStore(
    context.db,
    new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
  );
  const workerStore = new PgWebScanWorkerStore(context.db);
  await store.updateSettings('admin-1', {
    paused: false,
    contact: 'security@example.com',
    checks: options.checks ?? {
      headers: true,
      cookies: true,
      transport: false,
      disclosure: false,
      files: false,
      active: false,
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const hostname = options.hostname ?? '127.0.0.1';
  const baseUrl = `https://${hostname}`;
  const site = await store.createSite('admin-1', {
    hostname,
    baseUrl,
    ownerUserId: 'admin-1',
    scope: { ...defaultScope(hostname, baseUrl), crawlPaths: options.crawlPaths ?? [] },
    authorizedBy: 'admin-1',
  });
  const queued = await store.enqueueManualScan('admin-1', {
    siteId: site.id,
    idempotencyKey: options.idempotencyKey ?? `key-${site.id}`,
  });
  return {
    context,
    store,
    workerStore,
    siteId: site.id,
    scanId: queued.scan.id,
    connectionString: context.connectionString,
  };
}

/** One request that reached the fixture transport. */
export interface FixtureRequest {
  url: string;
  method: string;
}

/** The fixture transport: the network of the scanner, without a socket. */
export interface FixtureTransport {
  /** The requests that reached the transport, in order. */
  readonly requests: readonly FixtureRequest[];
  /** Whether a parked request was aborted by the abort signal. */
  readonly aborted: boolean;
  /** The transport itself, shaped like the guarded transport of the app. */
  readonly fetch: (
    url: string,
    init: { method: 'GET' | 'HEAD'; signal: AbortSignal },
  ) => Promise<Response>;
  /** Waits until the given number of requests arrived. */
  waitForRequests(count: number, timeoutMs?: number): Promise<boolean>;
  /** Releases the parked requests. */
  release(): void;
}

/** The options of {@link createFixtureTransport}. */
export interface FixtureTransportOptions {
  /** The body the transport serves. */
  body?: string;
  /** Whether every request parks until it is released. */
  park?: boolean;
}

/**
 * Creates the fixture transport.
 *
 * A parked request waits for the release of the test or for the abort of the run. It never
 * opens a socket, so the proof never sends a request to a host outside the machine.
 */
export function createFixtureTransport(options: FixtureTransportOptions = {}): FixtureTransport {
  const requests: FixtureRequest[] = [];
  const body = options.body ?? RECOVERY_PAGE;
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const state = { aborted: false };

  const fetch = async (
    url: string,
    init: { method: 'GET' | 'HEAD'; signal: AbortSignal },
  ): Promise<Response> => {
    requests.push({ url, method: init.method });
    if (options.park !== true) {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        state.aborted = true;
        reject(init.signal.reason ?? new Error('the run was aborted'));
      };
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener('abort', onAbort, { once: true });
      void gate.then(() => {
        init.signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  return {
    requests,
    get aborted(): boolean {
      return state.aborted;
    },
    fetch,
    async waitForRequests(count: number, timeoutMs = 20_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (requests.length >= count) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    release(): void {
      releaseGate();
    },
  };
}

/**
 * The holder of the transport of a test.
 *
 * The runtime has no seam for the transport, so the test file mocks the factory of the app
 * and points it at the transport of the test. The factory is the only thing that is replaced:
 * the scan runner, the store, the claim, the lease and the queue are the production ones.
 */
export interface TransportHolder {
  current: FixtureTransport | null;
}

/** Waits until the check holds or the time is over. */
export async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The advisory lock key of the scanner. */
export const LEASE_LOCK_KEY = '715694339021884417';

/**
 * The backends that hold the advisory lock of the scanner right now.
 *
 * The query is evidence only: the assertion of the proof is the outcome of the production
 * lease, never this query.
 */
export async function advisoryLockHolders(pool: Pool): Promise<
  { pid: number; applicationName: string }[]
> {
  const result = await pool.query<{ pid: number; application_name: string }>(
    `SELECT l.pid, a.application_name FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
         AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint`,
    [LEASE_LOCK_KEY],
  );
  return result.rows.map((row) => ({ pid: row.pid, applicationName: row.application_name }));
}

/** The outbox state of a scan, read from the database. */
export async function readOutboxState(pool: Pool, scanId: string): Promise<string | null> {
  const result = await pool.query<{ outbox_state: string }>(
    'SELECT outbox_state FROM web_scans WHERE id = $1',
    [scanId],
  );
  return result.rows[0]?.outbox_state ?? null;
}

/** The state of a scan, read from the database. */
export async function readScanRow(
  pool: Pool,
  scanId: string,
): Promise<{
  status: string;
  attempt_id: string | null;
  stop_reason: string | null;
  fail_reason: string | null;
  requests: number | null;
  finished_at: Date | null;
} | null> {
  const result = await pool.query<{
    status: string;
    attempt_id: string | null;
    stop_reason: string | null;
    fail_reason: string | null;
    requests: number | null;
    finished_at: Date | null;
  }>(
    `SELECT status, attempt_id, stop_reason, fail_reason, requests, finished_at
       FROM web_scans WHERE id = $1`,
    [scanId],
  );
  return result.rows[0] ?? null;
}

/** The number of audit rows of one action and one target. */
export async function countAuditRows(
  pool: Pool,
  scanId: string,
  action: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM web_scan_audit WHERE target_id = $1 AND action = $2',
    [scanId, action],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** The number of scans of a site. */
export async function countScans(pool: Pool, siteId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM web_scans WHERE site_id = $1',
    [siteId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** The number of findings of a scan. */
export async function countFindings(pool: Pool, scanId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM web_scan_findings WHERE scan_id = $1',
    [scanId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** The number of ledger rows of a site. */
export async function countOccurrences(pool: Pool, siteId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM web_scan_occurrences WHERE site_id = $1',
    [siteId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** A child process of the proof and the lines it printed. */
export interface RecoveryChild {
  /** The process. */
  child: ChildProcessWithoutNullStreams;
  /** The lines the process printed on its standard output. */
  readonly lines: readonly string[];
  /** The exit code of the process, or null while it runs. */
  readonly exitCode: number | null;
  /** The signal that killed the process, or null while it runs. */
  readonly signalCode: NodeJS.Signals | null;
  /** Waits until the process printed a line that holds the marker. */
  waitForLine(marker: string, timeoutMs?: number): Promise<string>;
  /** Waits until the process ended. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  /** Stops the process and waits for its end. */
  stop(): Promise<void>;
}

/** Starts a child process of the proof and collects the lines it prints. */
export function startRecoveryChild(
  script: string,
  args: readonly string[],
): RecoveryChild {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let buffer = '';
  const collect = (chunk: string): void => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    collect(chunk);
  });
  // The errors of the child are collected too, so a failure of a child is readable.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    collect(chunk);
  });

  return {
    child,
    lines,
    get exitCode(): number | null {
      return child.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return child.signalCode;
    },
    async waitForLine(marker: string, timeoutMs = 30_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find((line) => line.includes(marker));
        if (found !== undefined) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `the child process printed no line with "${marker}". It printed: ${lines.join(' | ')}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async waitForExit(timeoutMs = 30_000): Promise<number | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
        if (Date.now() >= deadline) {
          throw new Error('the child process did not end');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
    },
  };
}

/** The path of a fixture script. */
export function fixtureScript(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The queue of the scanner on the dedicated Redis of this wave. */
export function createRecoveryQueue(): Queue<{ scanId: string }> {
  return new Queue<{ scanId: string }>('web-scan', {
    connection: createQueueConnection(INTEGRATION_REDIS_URL),
  });
}

/** The connection of the scanner queue on the dedicated Redis of this wave. */
export function createRecoveryConnection(): Redis {
  return createQueueConnection(INTEGRATION_REDIS_URL);
}

/** A Redis client on the dedicated Redis of this wave. */
export function createRecoveryRedis(): Redis {
  return new Redis(INTEGRATION_REDIS_URL, { maxRetriesPerRequest: null });
}

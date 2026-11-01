import { describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { WebScanAbortRegistry } from '../../src/webscan/abort.js';
import {
  isJobLocked,
  jobLockKey,
  publishScanJob,
  scanJobId,
  WEB_SCAN_JOB_NAME,
} from '../../src/webscan/queue.js';
import { startWebScanRuntime } from '../../src/webscan/runtime.js';
import { processScanJob, type WebScanWorkerDeps } from '../../src/webscan/worker.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import {
  advisoryLockHolders,
  countAuditRows,
  countFindings,
  countOccurrences,
  createFixtureTransport,
  createRecoveryConnection,
  createRecoveryFixture,
  createRecoveryQueue,
  fixtureScript,
  readScanRow,
  RECOVERY_MASTER_KEY,
  RECOVERY_PAGE_WITH_LINK,
  RECOVERY_PLATFORM_ADMINS,
  startRecoveryChild,
  until,
  type FixtureTransport,
  type RecoveryFixture,
} from './web-scan-recovery.fixtures.js';
import { hasIntegrationEnv, INTEGRATION_REDIS_URL } from './test-helper.js';

/**
 * The replay and the shutdown proof of the scanner.
 *
 * Every case runs against the dedicated containers of this wave. The queue, the runtime, the
 * worker, the claim and the lease are the production ones. The transport of the scanner is
 * the only thing that is replaced, so no request of the proof leaves the machine.
 */

const transportHolder = vi.hoisted(
  () => ({ current: null }) as { current: FixtureTransport | null },
);

vi.mock('../../src/webscan/worker-defaults.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/webscan/worker-defaults.js')>();
  return {
    ...actual,
    defaultFetchFactory: (_options: { hostname: string; contact: string; maxResponseBytes: number }) => {
      const transport = transportHolder.current;
      if (transport === null) {
        throw new Error('the proof installed no fixture transport');
      }
      return transport.fetch;
    },
  };
});

/** One line the runtime of the scanner wrote. */
interface RuntimeLine {
  message: string;
  details: Record<string, unknown> | undefined;
}

/** The worker dependencies of the production worker, over the schema of the fixture. */
function workerDeps(fixture: RecoveryFixture, transport: FixtureTransport): WebScanWorkerDeps {
  // The store of the worker is the shared store plus the capability that opens the identity
  // key of a site. The key of the site is not the subject of the proof, so it is a fixed key.
  const store = new Proxy(fixture.store, {
    get(target, property, receiver): unknown {
      if (property === 'openSiteIdentityKey') {
        return async (): Promise<string> => Buffer.alloc(32, 3).toString('base64');
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    store,
    workerStore: fixture.workerStore,
    pool: fixture.context.pool,
    platformAdmins: RECOVERY_PLATFORM_ADMINS,
    createFetch: () => transport.fetch,
  };
}

describe.skipIf(!hasIntegrationEnv)(
  'the replay and the shutdown of the scanner on real Postgres and Redis',
  () => {
    it(
      'does not run a scan again when the job of a running scan is delivered again',
      async () => {
        const fixture = await createRecoveryFixture();
        const queue = createRecoveryQueue();
        const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const transport = createFixtureTransport();
        transportHolder.current = transport;
        let child: ReturnType<typeof startRecoveryChild> | undefined;
        try {
          await redis.connect();
          await redis.flushdb();

          // The job of the scan is published under the durable id of the scan.
          await publishScanJob(queue, fixture.scanId);

          // The worker of another process takes the job, claims the scan with the
          // production claim and parks the request of the scan.
          child = startRecoveryChild(fixtureScript('recovery-scan-worker.mjs'), [
            fixture.connectionString,
            INTEGRATION_REDIS_URL,
            fixture.scanId,
            RECOVERY_MASTER_KEY,
          ]);
          await child.waitForLine('claimed');
          await child.waitForLine('request');
          expect(child.lines.filter((line) => line.startsWith('request '))).toHaveLength(1);

          // The worker process dies while the scan is in flight. The scan of the database
          // stays running and its attempt is orphaned.
          await child.stop();
          const running = await readScanRow(fixture.context.pool, fixture.scanId);
          expect(running?.status).toBe('running');
          const attemptId = running?.attempt_id;
          expect(attemptId).not.toBeNull();

          // The worker of this process starts. The lock of the job of the dead worker
          // expires, the stalled check of the queue moves the job back to the wait list and
          // the job is delivered again under the same durable id.
          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
          });
          try {
            const delivered = await until(async () => {
              const job = await queue.getJob(scanJobId(fixture.scanId));
              if (job === undefined) return false;
              const state = await job.getState();
              return state === 'completed' || state === 'failed';
            }, 150_000);
            expect(delivered).toBe(true);

            // The job was delivered twice: the first delivery was the one of the dead
            // worker, the second one is the delivery of the stalled job.
            const job = await queue.getJob(scanJobId(fixture.scanId));
            expect(job?.name).toBe(WEB_SCAN_JOB_NAME);
            expect(job?.data.scanId).toBe(fixture.scanId);
            expect(job?.stalledCounter).toBe(1);
            expect(job?.attemptsStarted).toBe(2);

            // The delivery of the running scan did not claim it and did not send a request.
            const after = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(after?.status).toBe('running');
            expect(after?.attempt_id).toBe(attemptId);
            expect(transport.requests).toHaveLength(0);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.start')).toBe(1);
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }
        } finally {
          await child?.stop();
          await queue.close();
          await redis.quit();
          await fixture.context.close();
        }
      },
      180_000,
    );

    it(
      'does not run a finished scan again when its job is delivered again',
      async () => {
        const fixture = await createRecoveryFixture();
        const queue = createRecoveryQueue();
        const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const transport = createFixtureTransport();
        transportHolder.current = transport;
        try {
          await redis.connect();
          await redis.flushdb();

          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
          });
          try {
            const finished = await until(async () => {
              const row = await readScanRow(fixture.context.pool, fixture.scanId);
              return row?.status === 'completed';
            }, 60_000);
            expect(finished).toBe(true);

            // The scan ran once: one request, one claim, one outcome.
            expect(transport.requests).toHaveLength(1);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.start')).toBe(1);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.complete')).toBe(1);
            const findings = await countFindings(fixture.context.pool, fixture.scanId);
            const occurrences = await countOccurrences(fixture.context.pool, fixture.siteId);

            // The job of the finished scan is delivered again under the same durable id.
            // The job is removed from Redis and published again, which is what the
            // production recovery does for a queued scan.
            const job = await queue.getJob(scanJobId(fixture.scanId));
            expect(job).not.toBeUndefined();
            await job?.remove();
            expect(await queue.getJob(scanJobId(fixture.scanId))).toBeUndefined();
            await publishScanJob(queue, fixture.scanId);

            const delivered = await until(async () => {
              const again = await queue.getJob(scanJobId(fixture.scanId));
              if (again === undefined) return false;
              const state = await again.getState();
              return state === 'completed' || state === 'failed';
            }, 60_000);
            expect(delivered).toBe(true);

            // The replay never contacted the transport and changed nothing.
            expect(transport.requests).toHaveLength(1);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.start')).toBe(1);
            expect(await countAuditRows(fixture.context.pool, fixture.scanId, 'scan.complete')).toBe(1);
            expect(await countFindings(fixture.context.pool, fixture.scanId)).toBe(findings);
            expect(await countOccurrences(fixture.context.pool, fixture.siteId)).toBe(occurrences);
            const row = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(row?.status).toBe('completed');
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }
        } finally {
          await queue.close();
          await redis.quit();
          await fixture.context.close();
        }
      },
      180_000,
    );

    it(
      'stops the run that is in flight when the runtime closes, and waits for the terminal state',
      async () => {
        const fixture = await createRecoveryFixture();
        const queue = createRecoveryQueue();
        const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const transport = createFixtureTransport({ park: true });
        transportHolder.current = transport;
        try {
          await redis.connect();
          await redis.flushdb();

          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
          });
          try {
            // The response of the fixture is in flight: the scan claimed the scan and waits.
            expect(await transport.waitForRequests(1, 30_000)).toBe(true);
            const running = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(running?.status).toBe('running');

            // The runtime closes while the response is in flight.
            await runtime.close();

            // The request of the fixture was aborted.
            expect(transport.aborted).toBe(true);
            // The terminal state of the scan is written before the close resolved, so the
            // runtime waited for the cleanup of the scan.
            const after = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(after?.status).toBe('stopped');
            expect(after?.stop_reason).toBe('shutdown');
            expect(after?.finished_at).not.toBeNull();
            // The pool of the caller is still open, so the terminal state was written while
            // the database was still reachable. Nothing closed it before the write.
            expect(fixture.context.pool.ended).toBe(false);
            // The lease of the scan was released: no lock is left behind.
            expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(0);
            // The worker of the runtime is closed.
            expect(runtime.worker.isRunning()).toBe(false);
            // A second close changes nothing.
            await expect(runtime.close()).resolves.toBeUndefined();
            // No further request was sent.
            expect(transport.requests).toHaveLength(1);
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }

          // A job that is delivered after the runtime closed sends no request: the worker of
          // the runtime is closed.
          const late = await fixture.store.enqueueManualScan('admin-1', {
            siteId: fixture.siteId,
            idempotencyKey: 'late-after-close',
          });
          await publishScanJob(queue, late.scan.id);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          expect(transport.requests).toHaveLength(1);
          const lateRow = await readScanRow(fixture.context.pool, late.scan.id);
          expect(lateRow?.status).toBe('queued');

          // The production registry of the aborts refuses a run after its shutdown, and the
          // production worker stops the scan before it claims it and before it sends a
          // request.
          const registry = new WebScanAbortRegistry();
          registry.shutdown();
          const controller = registry.begin(late.scan.id);
          expect(controller.aborted).toBe(true);
          const outcome = await processScanJob(
            late.scan.id,
            workerDeps(fixture, transport),
            { abort: controller },
          );
          expect(outcome).toBe('stopped');
          expect(transport.requests).toHaveLength(1);
          const stopped = await readScanRow(fixture.context.pool, late.scan.id);
          expect(stopped?.status).toBe('stopped');
          expect(stopped?.stop_reason).toBe('shutdown');
        } finally {
          await queue.close();
          await redis.quit();
          await fixture.context.close();
        }
      },
      120_000,
    );

    it(
      'stops the run that is in flight when the lock of its job is really lost',
      async () => {
        // The deadline of one request is the longest the settings allow, so the run of the
        // scan is still in flight when the worker finds out that it lost the lock of its
        // job. The deadline of the request is not the subject of this case.
        const fixture = await createRecoveryFixture({ limits: { requestTimeoutMs: 30_000 } });
        const queue = createRecoveryQueue();
        const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const transport = createFixtureTransport({ park: true });
        transportHolder.current = transport;
        const lines: RuntimeLine[] = [];
        const logger = {
          info: (message: string, details?: Record<string, unknown>): void => {
            lines.push({ message, details });
          },
          warn: (message: string, details?: Record<string, unknown>): void => {
            lines.push({ message, details });
          },
          error: (message: string, details?: Record<string, unknown>): void => {
            lines.push({ message, details });
          },
        };
        try {
          await redis.connect();
          await redis.flushdb();

          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
            logger,
          });
          try {
            // The response of the fixture is in flight.
            expect(await transport.waitForRequests(1, 30_000)).toBe(true);

            // The lock of the job is really gone: the Redis key of the lock is deleted, so
            // the worker cannot renew it any more.
            const key = jobLockKey(queue, scanJobId(fixture.scanId));
            expect(await redis.exists(key)).toBe(1);
            await redis.del(key);
            expect(await redis.exists(key)).toBe(0);
            expect(await isJobLocked(queue, scanJobId(fixture.scanId))).toBe(false);

            // The runtime stops the run: the renewal of the lock fails.
            const stopped = await until(async () => {
              const row = await readScanRow(fixture.context.pool, fixture.scanId);
              return (
                row?.status === 'stopped' || row?.status === 'failed' || row?.status === 'completed'
              );
            }, 90_000);
            expect(stopped).toBe(true);

            const row = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(row).toMatchObject({ status: 'stopped', stop_reason: 'job_lock_lost' });
            // The request of the fixture was aborted and no other request was sent.
            expect(transport.aborted).toBe(true);
            expect(transport.requests).toHaveLength(1);
            // The gate of the runtime fired with the id of the job that lost its lock.
            const gate = lines.find((line) => line.message === 'The web scan lost the lock of its job');
            expect(gate).toBeDefined();
            expect(gate?.details?.scanId).toBe(fixture.scanId);
            expect(gate?.details?.jobId).toBe(scanJobId(fixture.scanId));
            // The lease of the scan was released.
            expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(0);
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }
        } finally {
          await queue.close();
          await redis.quit();
          await fixture.context.close();
        }
      },
      180_000,
    );

    it(
      'stops the scan before the next request when the administrator of the site is no longer verified',
      async () => {
        const fixture = await createRecoveryFixture({
          crawlPaths: [{ path: '/', kind: 'prefix' }],
        });
        const queue = createRecoveryQueue();
        const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const transport = createFixtureTransport({ park: true, body: RECOVERY_PAGE_WITH_LINK });
        transportHolder.current = transport;
        try {
          await redis.connect();
          await redis.flushdb();

          const runtime = await startWebScanRuntime({
            db: fixture.context.db,
            pool: fixture.context.pool,
            vault: new PurposeScopedVault({ masterKey: RECOVERY_MASTER_KEY }),
            platformAdmins: RECOVERY_PLATFORM_ADMINS,
            connection: createRecoveryConnection(),
          });
          try {
            // The first request of the scan is in flight. It was authorized, because the
            // administrator was verified when the scan claimed it.
            expect(await transport.waitForRequests(1, 30_000)).toBe(true);
            const running = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(running?.status).toBe('running');

            // The administrator that authorized the site is no longer verified.
            await fixture.context.pool.query(
              'UPDATE "user" SET "emailVerified" = false WHERE id = $1',
              ['admin-1'],
            );

            // The response of the first request arrives and the crawl follows the link of
            // the page.
            transport.release();

            const stopped = await until(async () => {
              const row = await readScanRow(fixture.context.pool, fixture.scanId);
              return row?.status === 'stopped' || row?.status === 'failed';
            }, 60_000);
            expect(stopped).toBe(true);

            const row = await readScanRow(fixture.context.pool, fixture.scanId);
            expect(row?.status).toBe('stopped');
            expect(row?.stop_reason).toBe('authorization_revoked');
            // The next request never reached the transport: the live check of the
            // administrator stopped the scan before it.
            expect(transport.requests).toHaveLength(1);
            expect(transport.requests[0]?.url).toBe('https://127.0.0.1/');
            // The lease of the scan was released.
            expect(await advisoryLockHolders(fixture.context.pool)).toHaveLength(0);
          } finally {
            await runtime.close();
            transportHolder.current = null;
          }
        } finally {
          await queue.close();
          await redis.quit();
          await fixture.context.close();
        }
      },
      180_000,
    );
  },
);

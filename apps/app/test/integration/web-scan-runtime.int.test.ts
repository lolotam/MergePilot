import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createQueueConnection } from '../../src/queue/bullmq-queue.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { defaultScope } from '../../src/webscan/pg-rows.js';
import { isJobLocked, scanJobId, WEB_SCAN_JOB_NAME } from '../../src/webscan/queue.js';
import { dispatchOutbox } from '../../src/webscan/outbox.js';
import { reconcileOrphanedAttempts } from '../../src/webscan/reconciliation.js';
import { startWebScanRuntime } from '../../src/webscan/runtime.js';
import { PgWebScanWorkerStore } from '../../src/webscan/worker-store-persistence.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
  INTEGRATION_REDIS_URL,
  type TestPostgresContext,
} from './test-helper.js';

/**
 * The runtime of the scanner on a real Postgres and a real Redis.
 *
 * PGlite cannot show the behaviour that needs more than one connection, a real Redis
 * and more than one process. These cases run against a real database and a real Redis:
 * a worker process that dies and leaves its attempt behind, the lock of a job that is
 * really gone, and a job that really failed before the claim.
 *
 * Every request of a scan stays inside the test: the site of the fixture is the
 * loopback address, which the transport of the scanner refuses before it connects, so
 * no request ever leaves the machine.
 */

const CRASHED_WORKER = fileURLToPath(
  new URL('./fixtures/crashed-worker.mjs', import.meta.url),
);

const STALLING_WORKER = fileURLToPath(
  new URL('./fixtures/stalling-worker.mjs', import.meta.url),
);

if (!hasIntegrationEnv) {
  describe.skip('the web scan runtime on real Postgres and Redis (skipped: no integration env)', () => {
    it.skip('skipped', () => {});
  });
} else {
  const masterKey = Buffer.alloc(32, 7).toString('base64');
  const platformAdmins = ['admin@example.com'];

  interface Fixture {
    context: TestPostgresContext;
    store: PgWebScanStore;
    workerStore: PgWebScanWorkerStore;
    siteId: string;
    scanId: string;
  }

  async function fixture(): Promise<Fixture> {
    const context = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    // The administrator that authorized the site. The worker reads the identity of the
    // administrator again before the claim and before every request.
    await context.pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`,
      ['admin-1', 'Admin', platformAdmins[0]],
    );
    const store = new PgWebScanStore(context.db, new PurposeScopedVault({ masterKey }));
    const workerStore = new PgWebScanWorkerStore(context.db);
    await store.updateSettings('admin-1', { paused: false, contact: 'security@example.com' });
    const site = await store.createSite('admin-1', {
      hostname: '127.0.0.1',
      baseUrl: 'https://127.0.0.1',
      ownerUserId: 'admin-1',
      scope: defaultScope('127.0.0.1', 'https://127.0.0.1'),
      authorizedBy: 'admin-1',
    });
    const queued = await store.enqueueManualScan('admin-1', {
      siteId: site.id,
      idempotencyKey: 'key-1',
    });
    return {
      context,
      store,
      workerStore,
      siteId: site.id,
      scanId: queued.scan.id,
    };
  }

  /** Waits until the check holds or the time is over. */
  async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Starts the worker process that takes the job and then waits to be killed. */
  function startCrashedWorker(
    connectionString: string,
    scanId: string,
  ): { child: ChildProcessByStdio<null, Readable, Readable>; locked: Promise<void> } {
    const child = spawn(
      process.execPath,
      [CRASHED_WORKER, connectionString, INTEGRATION_REDIS_URL, scanId, randomUUID()],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const locked = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`the worker process exited with ${code}`)));
    });
    return { child, locked };
  }

  describe('the web scan runtime on real Postgres and Redis', () => {
    it('marks a stale attempt of a crashed worker failed, because its job lock is gone', async () => {
      const f = await fixture();
      const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
      const connection = createQueueConnection(INTEGRATION_REDIS_URL);
      let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
      try {
        await redis.connect();
        await redis.flushdb();

        // The job of the scan exists, and a worker process of another deployment holds
        // its lock.
        await f.workerStore.markOutboxPublished({ scanId: f.scanId, now: new Date() });
        const queue = await import('../../src/webscan/queue.js');
        const bullQueue = queue.createWebScanQueue({ connection });
        await bullQueue.add(WEB_SCAN_JOB_NAME, { scanId: f.scanId }, { jobId: scanJobId(f.scanId) });

        const crashed = startCrashedWorker(f.context.connectionString, f.scanId);
        child = crashed.child;
        await crashed.locked;

        // The lock of a live worker is really in Redis.
        expect(await isJobLocked(bullQueue, scanJobId(f.scanId))).toBe(true);

        // The worker dies. The lock of BullMQ expires on its own.
        child.kill('SIGKILL');
        child = undefined;
        expect(
          await until(async () => (await isJobLocked(bullQueue, scanJobId(f.scanId))) === false),
        ).toBe(true);

        // The runtime reconciles the orphaned attempt at startup.
        const runtime = await startWebScanRuntime({
          db: f.context.db,
          pool: f.context.pool,
          vault: new PurposeScopedVault({ masterKey }),
          platformAdmins,
          connection,
        });
        try {
          const scan = await f.store.getScan(f.scanId);
          expect(scan?.status).toBe('failed');
          expect(scan?.failReason).toBe('worker_lost');
        } finally {
          await runtime.close();
          await bullQueue.close();
        }
      } finally {
        child?.kill('SIGKILL');
        connection.disconnect();
        redis.disconnect();
        await f.context.close();
      }
    });

    it('leaves a stale attempt alone while the lock of its job is alive', async () => {
      const f = await fixture();
      const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
      const connection = createQueueConnection(INTEGRATION_REDIS_URL);
      let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
      try {
        await redis.connect();
        await redis.flushdb();

        await f.workerStore.markOutboxPublished({ scanId: f.scanId, now: new Date() });
        const { createWebScanQueue } = await import('../../src/webscan/queue.js');
        const bullQueue = createWebScanQueue({ connection });
        await bullQueue.add(WEB_SCAN_JOB_NAME, { scanId: f.scanId }, { jobId: scanJobId(f.scanId) });

        const crashed = startCrashedWorker(f.context.connectionString, f.scanId);
        child = crashed.child;
        await crashed.locked;

        // The lock is alive, so the attempt is not orphaned: the reconciliation leaves
        // it pending instead of guessing it away.
        const reconciled = await reconcileOrphanedAttempts({
          store: f.store,
          workerStore: f.workerStore,
          pool: f.context.pool,
          platformAdmins,
          queue: bullQueue,
        });
        expect(reconciled).toBe(0);
        const scan = await f.store.getScan(f.scanId);
        expect(scan?.status).toBe('running');

        await bullQueue.close();
      } finally {
        child?.kill('SIGKILL');
        connection.disconnect();
        redis.disconnect();
        await f.context.close();
      }
    });

    it('cancels a queued scan without sending a request, and a second cancel changes nothing', async () => {
      const f = await fixture();
      const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
      const connection = createQueueConnection(INTEGRATION_REDIS_URL);
      try {
        await redis.connect();
        await redis.flushdb();

        const runtime = await startWebScanRuntime({
          db: f.context.db,
          pool: f.context.pool,
          vault: new PurposeScopedVault({ masterKey }),
          platformAdmins,
          connection,
        });
        try {
          // The cancel stops the queued scan in the database.
          const first = await runtime.cancel(f.scanId);
          expect(first.state).toBe('stopped');

          // The cancel is idempotent: a second cancel writes nothing.
          const second = await runtime.cancel(f.scanId);
          expect(second.state).toBe('fenced');

          const scan = await f.store.getScan(f.scanId);
          expect(scan?.status).toBe('stopped');
          expect(scan?.stopReason).toBe('cancelled');

          // The audit log holds exactly one stop row for the scan.
          const audit = await f.context.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM web_scan_audit WHERE action = 'scan.stop' AND target_id = $1`,
            [f.scanId],
          );
          expect(audit.rows[0]?.count).toBe('1');
        } finally {
          await runtime.close();
        }
      } finally {
        connection.disconnect();
        redis.disconnect();
        await f.context.close();
      }
    });

    it('reports the loss of the lock of a job when the lock of the job really expires', async () => {
      const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
      const connection = createQueueConnection(INTEGRATION_REDIS_URL);
      let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
      try {
        await redis.connect();
        await redis.flushdb();

        const { createWebScanQueue, createWebScanWorker } = await import('../../src/webscan/queue.js');
        const bullQueue = createWebScanQueue({ connection });
        const jobId = 'lock-loss-job';
        await bullQueue.add(WEB_SCAN_JOB_NAME, { scanId: 'scan-1' }, { jobId });

        // A worker process of another deployment takes the job and then blocks its own
        // event loop, so the lock of the job is not renewed.
        child = spawn(process.execPath, [STALLING_WORKER, INTEGRATION_REDIS_URL, 'web-scan'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const holding = new Promise<void>((resolve, reject) => {
          child?.stdout.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('holding')) resolve();
          });
          child?.on('error', reject);
          child?.on('exit', (code) =>
            reject(new Error(`the stalling worker exited with ${code}`)),
          );
        });
        await holding;

        // The worker of this process starts after the job is taken. It watches the
        // queue for the jobs whose lock expired.
        const lost: string[] = [];
        const worker = createWebScanWorker({
          connection,
          lockDuration: 1_000,
          stalledInterval: 1_000,
          processor: async () => {
            // The job is released again, so the worker of this process does not keep it.
          },
          onJobLockLost: (id) => {
            lost.push(id);
          },
        });
        try {
          // The lock of the job expires and the queue reports the stall: the worker
          // that ran the job does not own it any more.
          const reported = await until(() => Promise.resolve(lost.includes(jobId)), 30_000);
          expect(reported).toBe(true);
        } finally {
          await worker.close();
          await bullQueue.close();
        }
      } finally {
        child?.kill('SIGKILL');
        connection.disconnect();
        redis.disconnect();
      }
    });

    it('publishes a queued scan again under the same job id when its job failed before the claim', async () => {
      const f = await fixture();
      const redis = new Redis(INTEGRATION_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
      const connection = createQueueConnection(INTEGRATION_REDIS_URL);
      try {
        await redis.connect();
        await redis.flushdb();

        const { createWebScanQueue } = await import('../../src/webscan/queue.js');
        const bullQueue = createWebScanQueue({ connection });

        // The intent of the scan is published, but the job of the scan fails before the
        // claim: the worker of the runtime does not know this job name.
        await f.workerStore.markOutboxPublished({ scanId: f.scanId, now: new Date() });
        await bullQueue.add('broken-job', { scanId: f.scanId }, { jobId: scanJobId(f.scanId) });

        // A worker that fails every job it takes proves that the job really failed.
        const breaker = new Worker(
          'web-scan',
          async () => {
            throw new Error('the job of this worker always fails');
          },
          { connection, concurrency: 1 },
        );
        try {
          const failed = await until(async () => {
            const job = await bullQueue.getJob(scanJobId(f.scanId));
            return job !== undefined && job !== null && (await job.isFailed());
          }, 30_000);
          expect(failed).toBe(true);
        } finally {
          await breaker.close();
        }

        // The dispatcher finds the failed job of a queued scan and publishes the scan
        // again, under the same job id.
        const result = await dispatchOutbox({ store: f.workerStore, queue: bullQueue });
        expect(result.recovered).toBe(1);

        const job = await bullQueue.getJob(scanJobId(f.scanId));
        expect(job?.id).toBe(scanJobId(f.scanId));
        expect(job?.name).toBe(WEB_SCAN_JOB_NAME);

        const runtime = await startWebScanRuntime({
          db: f.context.db,
          pool: f.context.pool,
          vault: new PurposeScopedVault({ masterKey }),
          platformAdmins,
          connection,
        });
        try {
          // The scan is not stranded: it reaches a terminal state.
          const terminal = await until(async () => {
            const scan = await f.store.getScan(f.scanId);
            return scan !== null && scan.status !== 'queued' && scan.status !== 'running';
          }, 30_000);
          expect(terminal).toBe(true);
        } finally {
          await runtime.close();
          await bullQueue.close();
        }
      } finally {
        connection.disconnect();
        redis.disconnect();
        await f.context.close();
      }
    });
  });
}

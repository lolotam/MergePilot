import { WebScanAbortRegistry } from './abort.js';
import type { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { AppDb } from '../db/pg-store.js';
import type { ScopedSecretVault } from '../vault/scoped-secrets.js';
import type { WebScanEventPublisher } from './events.js';
import { dispatchOutbox, type OutboxDispatchResult } from './outbox.js';
import { PgWebScanStore } from './pg-store.js';
import {
  applyGlobalConcurrency,
  createWebScanQueue,
  createWebScanWorker,
  registerWebScanTick,
  scanJobId,
  WEB_SCAN_JOB_NAME,
  WEB_SCAN_TICK_JOB_NAME,
  type WebScanJobData,
  type WebScanQueueData,
} from './queue.js';
import { PgWebScanWorkerStore } from './worker-store-persistence.js';
import { reconcileOrphanedAttempts } from './reconciliation.js';
import { processScanJob, type WebScanWorkerLogger } from './worker.js';

/**
 * The runtime of the website security scanner (ADR-0052 section 7).
 *
 * The runtime owns the queue, the worker and the two loops that keep the scanner
 * moving: the 15-minute tick, which queues the due occurrences of every site, and the
 * dispatcher, which publishes the queued intents that were not published yet.
 *
 * The runtime is created by the worker process. The web server never publishes a scan:
 * it writes the durable intent and the dispatcher of the worker publishes it.
 */

/** The options of the scanner runtime. */
export interface WebScanRuntimeOptions {
  /** The database. */
  db: AppDb;
  /** The pool the advisory lease is taken from. */
  pool: Pool;
  /** The purpose-scoped vault that opens the identity key of a site. */
  vault: ScopedSecretVault;
  /** The deployed platform administrator list. */
  platformAdmins: readonly string[];
  /** The Redis connection of the queue. */
  connection: ConnectionOptions | Redis;
  /** The logger. */
  logger?: WebScanWorkerLogger | undefined;
  /** The progress publisher. */
  events?: WebScanEventPublisher | undefined;
  /** The clock. */
  now?: (() => Date) | undefined;
  /** How often the dispatcher publishes the unpublished intents, in milliseconds. */
  dispatchIntervalMs?: number | undefined;
}

/** What one tick did. */
export interface WebScanTickResult {
  /** True when the kill switch stopped the tick. */
  skipped: boolean;
  /** The number of occurrences the tick queued. */
  queued: number;
  /** The number of orphaned attempts the reconciliation marked failed. */
  reconciled: number;
  /** The number of intents the dispatcher published. */
  published: number;
}

/** The default interval of the dispatcher. */
export const WEB_SCAN_DISPATCH_INTERVAL_MS = 5_000;

/** What one cancel did. */
export interface WebScanCancelResult {
  /** The scan that ran in this process was stopped before its next request. */
  aborted: boolean;
  /** What the database said about the scan. */
  state: 'stopped' | 'not_queued' | 'fenced' | 'not_found' | 'already_terminal';
}

/** The scanner runtime. */
export interface WebScanRuntime {
  queue: Queue<WebScanQueueData>;
  worker: Worker<WebScanQueueData>;
  store: PgWebScanStore;
  workerStore: PgWebScanWorkerStore;
  /** Runs one tick by hand. */
  runTick(): Promise<WebScanTickResult>;
  /** Runs one dispatch pass by hand. */
  dispatch(): Promise<OutboxDispatchResult>;
  /**
   * Cancels a queued scan or a scan running in this process.
   *
   * The cancel is idempotent and fenced: a scan that already reached a terminal state
   * is left alone, and a scan that runs in this process stops before it sends another
   * request.
   * A scan running in another process is reported as fenced and is not cancelled here.
   */
  cancel(scanId: string): Promise<WebScanCancelResult>;
  close(): Promise<void>;
}

/**
 * Starts the runtime of the scanner.
 *
 * The queue is limited to one scan at a time, the 15-minute tick is registered and the
 * dispatcher publishes the intents that are still unpublished. The reconciliation runs
 * once at startup and again on every tick.
 */
export async function startWebScanRuntime(options: WebScanRuntimeOptions): Promise<WebScanRuntime> {
  const now = options.now ?? (() => new Date());
  const store = new PgWebScanStore(options.db, options.vault);
  const workerStore = new PgWebScanWorkerStore(options.db);
  const queue = createWebScanQueue({ connection: options.connection });
  // The registry owns the abort of the run that runs now.
  const aborts = new WebScanAbortRegistry();

  // A startup stage that throws closes the queue, so its Redis connection and reconnect
  // timers do not outlive a process that goes on serving reviews.
  const closeQueueOnFailure = async <T>(stage: () => T | Promise<T>): Promise<T> => {
    try {
      return await stage();
    } catch (error) {
      await Promise.allSettled([queue.close()]);
      throw error;
    }
  };

  await closeQueueOnFailure(async () => {
    await applyGlobalConcurrency(queue);
    await registerWebScanTick(queue);
  });

  const workerDeps = {
    store,
    workerStore,
    pool: options.pool,
    platformAdmins: options.platformAdmins,
    now,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.events === undefined ? {} : { events: options.events }),
  };

  const dispatch = async (): Promise<OutboxDispatchResult> =>
    dispatchOutbox(
      {
        store: workerStore,
        queue,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      { now: now() },
    );

  const runTick = async (): Promise<WebScanTickResult> => {
    const settings = await store.getSettings();
    // The tick does nothing while the kill switch is on.
    if (settings.paused) {
      return { skipped: true, queued: 0, reconciled: 0, published: 0 };
    }

    const sites = await store.listSites();
    let queued = 0;
    for (const site of sites) {
      const scan = await workerStore.enqueueDueScheduledScan('worker:tick', {
        siteId: site.id,
        now: now(),
      });
      if (scan !== null) queued += 1;
    }

    const reconciled = await reconcileOrphanedAttempts({ ...workerDeps, queue });
    const result = await dispatch();

    return { skipped: false, queued, reconciled, published: result.published };
  };

  // The attempts of a worker that died are reconciled once at startup, before the
  // worker of this process starts and before the dispatcher publishes anything. A
  // running attempt whose BullMQ lock is gone is marked failed, so it does not stay
  // running forever.
  const reconciled = await reconcileOrphanedAttempts({ ...workerDeps, queue }).catch(
    (error: unknown) => {
      options.logger?.warn?.('The first web scan reconciliation failed', {
        error: error instanceof Error ? error.name : 'unknown error',
      });
      return 0;
    },
  );
  if (reconciled > 0) {
    options.logger?.info?.('The web scan reconciliation marked orphaned attempts failed', {
      reconciled,
    });
  }

  const worker = await closeQueueOnFailure(() => createWebScanWorker({
    connection: options.connection,
    processor: async (job) => {
      if (job.name === WEB_SCAN_TICK_JOB_NAME) {
        await runTick();
        return;
      }
      if (job.name === WEB_SCAN_JOB_NAME) {
        const scanId = (job.data as WebScanJobData).scanId;
        // The run owns an abort controller, so a cancel, a shutdown or a lost job lock
        // stops the run that is in flight.
        const controller = aborts.begin(scanId);
        try {
          await processScanJob(scanId, workerDeps, { abort: controller });
        } finally {
          aborts.end(controller);
        }
        return;
      }
      throw new Error(`Unknown web scan job name: ${job.name}`);
    },
    onJobLockLost: (jobId) => {
      // The lock of the running job is gone. The run does not hold the right to run it
      // any more, so it stops.
      const scanId = aborts.currentScanId;
      if (scanId === undefined) return;
      if (jobId !== scanJobId(scanId)) return;
      options.logger?.warn?.('The web scan lost the lock of its job', { scanId, jobId });
      aborts.abort('job_lock_lost');
    },
    onWorkerError: (error) => {
      // The worker cannot reach Redis, so it does not know whether it still owns the
      // job it runs. The run stops.
      options.logger?.warn?.('The web scan worker failed', { error: error.name });
      aborts.abort('job_lock_lost');
    },
  }));

  const dispatchInterval = Math.max(1_000, options.dispatchIntervalMs ?? WEB_SCAN_DISPATCH_INTERVAL_MS);
  const dispatchTimer = setInterval(() => {
    void dispatch().catch((error: unknown) => {
      options.logger?.warn?.('The web scan dispatch pass failed', {
        error: error instanceof Error ? error.name : 'unknown error',
      });
    });
  }, dispatchInterval);
  dispatchTimer.unref?.();

  // The intents that are already queued are published once at startup, so a worker
  // that was down publishes them without waiting for the first interval.
  await dispatch().catch((error: unknown) => {
    options.logger?.warn?.('The first web scan dispatch pass failed', {
      error: error instanceof Error ? error.name : 'unknown error',
    });
  });

  const cancel = async (scanId: string): Promise<WebScanCancelResult> => {
    // A scan that runs in this process stops before it sends another request.
    const aborted = aborts.abortScan(scanId, 'cancelled');
    // A queued scan is stopped in the database. The write is fenced, so a scan that
    // already reached a terminal state is left alone.
    const state = await workerStore.stopQueuedScan({
      scanId,
      reason: 'cancelled',
      now: now(),
    });
    options.logger?.info?.('The web scan was cancelled', { scanId, aborted, state });
    return { aborted, state };
  };

  return {
    queue,
    worker,
    store,
    workerStore,
    runTick,
    dispatch,
    cancel,
    close: async () => {
      clearInterval(dispatchTimer);
      // The run that is in flight stops first, so the worker does not wait for a scan
      // that would send another request into a process that is going away.
      aborts.shutdown();
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { FetchLike } from '@mergepilot/engine';
import type { AppStore } from '../core/types.js';
import { pricesNeedRefresh, runPriceRefresh } from './refresh-prices.js';
import { runRetention, type RetentionLogger } from './retention.js';

/** Maintenance jobs have their own queue so they never wait behind (or delay) reviews. */
export const MAINTENANCE_QUEUE = 'maintenance';
export const RETENTION_JOB_NAME = 'run-retention';
export const RETENTION_SCHEDULER_ID = 'daily-run-retention';
/** Every day at 03:00 UTC. */
export const RETENTION_CRON = '0 3 * * *';
export const REFRESH_PRICES_JOB_NAME = 'refresh-model-prices';
export const REFRESH_PRICES_SCHEDULER_ID = 'daily-refresh-model-prices';
/** Every day at 02:30 UTC (ADR-0016). */
export const REFRESH_PRICES_CRON = '30 2 * * *';

export interface MaintenanceScheduler {
  queue: Queue;
  worker: Worker;
  close: () => Promise<void>;
}

export interface MaintenanceSchedulerOptions {
  /** Test seam: the fetch the price refresh uses (its URLs are fixed constants). */
  priceFetch?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Registers the daily retention and price refresh jobs (idempotent upserts: every worker may call
 * them at startup, BullMQ keeps one schedule each) and a worker that runs them. BullMQ hands each
 * scheduled job to one worker; the store lease still guards against overlap with a manual "run
 * now". At startup a price refresh is also queued once when no price is stored or the newest one
 * is older than 24 h.
 */
export async function startMaintenanceScheduler(
  store: AppStore,
  connection: ConnectionOptions,
  logger?: RetentionLogger,
  options: MaintenanceSchedulerOptions = {},
): Promise<MaintenanceScheduler> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  const jobOpts = { removeOnComplete: 30, removeOnFail: 30 };
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { pattern: RETENTION_CRON, tz: 'UTC' },
    { name: RETENTION_JOB_NAME, opts: jobOpts },
  );
  await queue.upsertJobScheduler(
    REFRESH_PRICES_SCHEDULER_ID,
    { pattern: REFRESH_PRICES_CRON, tz: 'UTC' },
    { name: REFRESH_PRICES_JOB_NAME, opts: jobOpts },
  );
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === RETENTION_JOB_NAME) await runRetention(store, { logger });
      if (job.name === REFRESH_PRICES_JOB_NAME) {
        await runPriceRefresh(store, { logger, fetch: options.priceFetch, ...(options.now ? { now: options.now } : {}) });
      }
    },
    { connection, concurrency: 1 },
  );
  if (await pricesNeedRefresh(store, options.now?.() ?? new Date())) {
    await queue.add(REFRESH_PRICES_JOB_NAME, {}, jobOpts);
  }
  return {
    queue,
    worker,
    close: async () => {
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { AppStore } from '../core/types.js';
import { runRetention, type RetentionLogger } from './retention.js';

/** Maintenance jobs have their own queue so they never wait behind (or delay) reviews. */
export const MAINTENANCE_QUEUE = 'maintenance';
export const RETENTION_JOB_NAME = 'run-retention';
export const RETENTION_SCHEDULER_ID = 'daily-run-retention';
/** Every day at 03:00 UTC. */
export const RETENTION_CRON = '0 3 * * *';

export interface MaintenanceScheduler {
  queue: Queue;
  worker: Worker;
  close: () => Promise<void>;
}

/**
 * Registers the daily retention job (an idempotent upsert: every worker may call it at startup,
 * BullMQ keeps one schedule) and a worker that runs it. BullMQ hands each scheduled job to one
 * worker; the store lease still guards against overlap with a manual "run now".
 */
export async function startMaintenanceScheduler(
  store: AppStore,
  connection: ConnectionOptions,
  logger?: RetentionLogger,
): Promise<MaintenanceScheduler> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  await queue.upsertJobScheduler(
    RETENTION_SCHEDULER_ID,
    { pattern: RETENTION_CRON, tz: 'UTC' },
    { name: RETENTION_JOB_NAME, opts: { removeOnComplete: 30, removeOnFail: 30 } },
  );
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name !== RETENTION_JOB_NAME) return;
      await runRetention(store, { logger });
    },
    { connection, concurrency: 1 },
  );
  return {
    queue,
    worker,
    close: async () => {
      await Promise.allSettled([worker.close(), queue.close()]);
    },
  };
}

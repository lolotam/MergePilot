import { createHash } from 'node:crypto';
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The queue of the website security scanner (ADR-0052 section 7).
 *
 * The scanner has its own queue, so a scan never waits behind a review and a review
 * never waits behind a scan. The queue runs one scan at a time: the global concurrency
 * of the queue is 1 and the local concurrency of the worker is 1, so two workers of a
 * rolling deployment cannot scan at the same time either.
 *
 * The job id of a scan is its durable scan id. A dispatcher that retries an
 * unpublished outbox record therefore produces the same job id, and BullMQ keeps one
 * job for it: a crash between the Redis enqueue and the database acknowledgement can
 * neither create a second scan nor repeat a completed occurrence.
 */

/** The name of the scanner queue. */
export const WEB_SCAN_QUEUE_NAME = 'web-scan';

/** The job name of one scan. */
export const WEB_SCAN_JOB_NAME = 'web-scan-run';

/** The job name of the scheduling tick. */
export const WEB_SCAN_TICK_JOB_NAME = 'web-scan-tick';

/** The scheduler id of the tick. */
export const WEB_SCAN_TICK_SCHEDULER_ID = 'web-scan-tick';

/** The tick runs every 15 minutes. */
export const WEB_SCAN_TICK_EVERY_MS = 15 * 60 * 1000;

/** The data of one scan job. */
export interface WebScanJobData {
  /** The durable id of the scan. */
  scanId: string;
}

/** The data of the tick job. */
export interface WebScanTickJobData {
  /** The moment the tick started, as an ISO timestamp. */
  at: string;
}

/** The data the scanner queue carries. */
export type WebScanQueueData = WebScanJobData | WebScanTickJobData;

/** The job options of a scan job. */
const SCAN_JOB_OPTIONS: JobsOptions = {
  // The delivery is at least once. A redelivery of the same job id finds the scan
  // already claimed or already terminal and does nothing.
  //
  // A job that failed before the claim - a database that was not reachable yet, a
  // lease that another worker held - is retried under the same job id, so the durable
  // intent of the scan is never stranded by a transient error.
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
};

/** The job options of the tick job. */
const TICK_JOB_OPTIONS: JobsOptions = { removeOnComplete: 30, removeOnFail: 30 };

/**
 * The BullMQ job id of a scan.
 *
 * A safe id is used unchanged, so the job id is the scan id. A scan id that BullMQ
 * would reject is replaced by a digest of it, which keeps the mapping stable and
 * collision-free.
 */
export function scanJobId(scanId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(scanId)) return scanId;
  return `scan-${createHash('sha256').update(scanId, 'utf8').digest('hex').slice(0, 32)}`;
}

/** The options of the scanner queue. */
export interface WebScanQueueOptions {
  connection: ConnectionOptions | Redis;
  prefix?: string | undefined;
}

/** Creates the queue of the scanner. */
export function createWebScanQueue(options: WebScanQueueOptions): Queue<WebScanQueueData> {
  return new Queue<WebScanQueueData>(WEB_SCAN_QUEUE_NAME, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
}

/**
 * Limits the queue to one scan at a time.
 *
 * The setting lives in Redis, so it applies to every worker of the queue, not only to
 * the worker that set it.
 */
export async function applyGlobalConcurrency(queue: Queue<WebScanQueueData>): Promise<void> {
  await queue.setGlobalConcurrency(1);
}

/**
 * Registers the 15-minute tick.
 *
 * The registration is an upsert, so every worker may call it at startup and BullMQ
 * keeps exactly one schedule.
 */
export async function registerWebScanTick(queue: Queue<WebScanQueueData>): Promise<void> {
  await queue.upsertJobScheduler(
    WEB_SCAN_TICK_SCHEDULER_ID,
    { every: WEB_SCAN_TICK_EVERY_MS },
    { name: WEB_SCAN_TICK_JOB_NAME, data: { at: new Date(0).toISOString() }, opts: TICK_JOB_OPTIONS },
  );
}

/**
 * Publishes one scan.
 *
 * The job id is the durable scan id, so publishing the same scan twice produces one
 * job and never a second scan.
 */
export async function publishScanJob(queue: Queue<WebScanQueueData>, scanId: string): Promise<void> {
  await queue.add(WEB_SCAN_JOB_NAME, { scanId }, { ...SCAN_JOB_OPTIONS, jobId: scanJobId(scanId) });
}

/** The processor of the scanner worker. */
export type WebScanJobProcessor = (job: {
  name: string;
  id?: string | undefined;
  data: WebScanQueueData;
}) => Promise<void>;

/** The options of the scanner worker. */
export interface WebScanWorkerOptions {
  connection: ConnectionOptions | Redis;
  processor: WebScanJobProcessor;
  prefix?: string | undefined;
  /**
   * Called when the worker lost the lock of a job.
   *
   * BullMQ reports a lost lock when the renewal of the lock failed and when it moved a
   * job whose lock expired back to the wait list. The run that owns the job has to stop:
   * it does not hold the right to run it any more.
   */
  onJobLockLost?: ((jobId: string) => void) | undefined;
  /**
   * Called when the worker itself failed.
   *
   * A worker that cannot reach Redis does not know whether it still owns the job it
   * runs, so the run stops.
   */
  onWorkerError?: ((error: Error) => void) | undefined;
  /** How long the lock of a job lives, in milliseconds. */
  lockDuration?: number | undefined;
  /** How often the worker looks for the jobs whose lock expired, in milliseconds. */
  stalledInterval?: number | undefined;
}

/**
 * Creates the worker of the scanner.
 *
 * The local concurrency is 1, so one worker never runs two scans at the same time.
 */
export function createWebScanWorker(options: WebScanWorkerOptions): Worker<WebScanQueueData> {
  const worker = new Worker<WebScanQueueData>(
    WEB_SCAN_QUEUE_NAME,
    async (job) => {
      await options.processor({
        name: job.name,
        ...(job.id === undefined ? {} : { id: job.id }),
        data: job.data,
      });
    },
    {
      connection: options.connection,
      concurrency: 1,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.lockDuration === undefined ? {} : { lockDuration: options.lockDuration }),
      ...(options.stalledInterval === undefined ? {} : { stalledInterval: options.stalledInterval }),
    },
  );

  // The lock of a job is a Redis key with an expiry. When the renewal of the lock
  // failed, the worker does not know whether it still owns the job.
  worker.on('lockRenewalFailed', (jobIds: string[]) => {
    for (const jobId of jobIds) options.onJobLockLost?.(jobId);
  });
  // A stalled job is a job whose lock expired. It was moved back to the wait list, so
  // the worker that ran it does not own it any more.
  worker.on('stalled', (jobId: string) => {
    options.onJobLockLost?.(jobId);
  });
  worker.on('error', (error: Error) => {
    options.onWorkerError?.(error);
  });

  return worker;
}

/**
 * The Redis key of the lock of one job.
 *
 * The lock of BullMQ is a key that expires on its own, so the lock of a job whose
 * worker died is gone. The key of the lock is the key of the job and the suffix of the
 * lock.
 */
export function jobLockKey(queue: Queue<WebScanQueueData>, jobId: string): string {
  return `${queue.toKey(jobId)}:lock`;
}

/**
 * Whether a job still holds its lock in Redis.
 *
 * The membership of the active list is not a lock: a job stays listed as active while
 * its lock is gone, and the reconciliation must not trust the list.
 */
export async function isJobLocked(
  queue: Queue<WebScanQueueData>,
  jobId: string,
): Promise<boolean> {
  const client = await queue.getBackend().client;
  const token = await client.get(jobLockKey(queue, jobId));
  return token !== null;
}

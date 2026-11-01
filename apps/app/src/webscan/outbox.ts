import type { Queue } from 'bullmq';
import { publishScanJob, scanJobId, type WebScanQueueData } from './queue.js';
import type { WebScanWorkerStore } from './worker-store.js';

/**
 * The durable outbox of the scanner (ADR-0052 section 7).
 *
 * A queued scan is written to the database first and published to the queue second.
 * The database record is the intent, the queue is only the delivery. The dispatcher
 * publishes the records that are still unpublished under the durable scan id as the
 * BullMQ job id, so a retry after a crash produces the same job and never a second
 * scan.
 *
 * The dispatcher is safe to run from several processes: the job id is stable, so a
 * double publication produces one job.
 */

/** The logger of the dispatcher. */
export interface OutboxLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

/** The dependencies of the dispatcher. */
export interface OutboxDispatcherDeps {
  store: WebScanWorkerStore;
  queue: Queue<WebScanQueueData>;
  logger?: OutboxLogger | undefined;
}

/** The options of one dispatch pass. */
export interface OutboxDispatchOptions {
  /** The maximum number of records to publish in one pass. */
  limit?: number | undefined;
  /** The moment the pass runs. */
  now?: Date | undefined;
}

/** What one dispatch pass did. */
export interface OutboxDispatchResult {
  /** The records that were published. */
  published: number;
  /** The records whose delivery could not be established. */
  unknown: number;
  /** The records that were republished because their job had vanished. */
  recovered: number;
  /** The records that were still not published at the end of the pass. */
  remaining: number;
}

/** The default number of records one pass publishes. */
export const OUTBOX_DISPATCH_BATCH = 50;

/**
 * Publishes the unpublished outbox records.
 *
 * A record is published under the durable scan id, so publishing it twice is
 * harmless. A publication whose outcome cannot be established is marked unknown
 * instead of failed: it is retried later under the same job id, and the durable
 * record stays the single source of truth.
 */
export async function dispatchOutbox(
  deps: OutboxDispatcherDeps,
  options: OutboxDispatchOptions = {},
): Promise<OutboxDispatchResult> {
  const limit = Math.max(1, options.limit ?? OUTBOX_DISPATCH_BATCH);
  const now = options.now ?? new Date();

  const pending = await deps.store.listPendingOutboxScans(limit);
  let published = 0;
  let unknown = 0;

  for (const entry of pending) {
    try {
      await publishScanJob(deps.queue, entry.scanId);
      await deps.store.markOutboxPublished({ scanId: entry.scanId, now });
      published += 1;
    } catch (error) {
      // The outcome of the publication is unknown: the job may exist even though the
      // call failed. The record is marked unknown and retried under the same job id.
      await deps.store.markOutboxUnknown({ scanId: entry.scanId, now });
      unknown += 1;
      deps.logger?.warn?.('The web scan outbox publication is unknown', {
        scanId: entry.scanId,
        error: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }

  const recovered = await recoverVanishedJobs(deps, limit);

  const remaining = await deps.store.listPendingOutboxScans(limit);
  return { published, unknown, recovered, remaining: remaining.length };
}

/**
 * Republishes the queued scans whose job no longer exists or whose job failed.
 *
 * The scan is still queued and its outbox record says it was published, but the job
 * is gone: Redis was flushed, or the job was removed. Publishing it again under the
 * same job id restores the delivery without creating a second scan.
 *
 * A job that failed before the claim is treated the same way. The attempts of a job
 * are finite, and a scan whose job failed before the claim is still a queued scan:
 * its durable intent must not be stranded by the failure of one delivery. The failed
 * job is removed and the scan is published again under the same job id, so the next
 * attempt of the scan continues under the id that was reserved for it.
 */
async function recoverVanishedJobs(deps: OutboxDispatcherDeps, limit: number): Promise<number> {
  const candidates = await deps.store.listPublishedQueuedScans(limit);
  let recovered = 0;
  for (const entry of candidates) {
    let job: Awaited<ReturnType<Queue<WebScanQueueData>['getJob']>>;
    try {
      job = await deps.queue.getJob(scanJobId(entry.scanId));
    } catch (error) {
      deps.logger?.warn?.('The web scan job could not be read', {
        scanId: entry.scanId,
        error: error instanceof Error ? error.name : 'unknown error',
      });
      continue;
    }

    if (job !== null && job !== undefined) {
      let failed: boolean;
      try {
        failed = await job.isFailed();
      } catch (error) {
        deps.logger?.warn?.('The web scan job state could not be read', {
          scanId: entry.scanId,
          error: error instanceof Error ? error.name : 'unknown error',
        });
        continue;
      }
      // A job that is waiting, active or completed is left alone.
      if (!failed) continue;
      try {
        await job.remove();
      } catch (error) {
        deps.logger?.warn?.('The failed web scan job could not be removed', {
          scanId: entry.scanId,
          error: error instanceof Error ? error.name : 'unknown error',
        });
        continue;
      }
    }

    try {
      await publishScanJob(deps.queue, entry.scanId);
      recovered += 1;
      deps.logger?.info?.('The web scan job was published again', { scanId: entry.scanId });
    } catch (error) {
      deps.logger?.warn?.('The web scan job could not be published again', {
        scanId: entry.scanId,
        error: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }
  return recovered;
}

import type { Queue } from 'bullmq';
import { acquireScanLease, type ScanLease } from './lease.js';
import { isJobLocked, scanJobId, type WebScanQueueData } from './queue.js';
import type { WebScanWorkerDeps } from './worker.js';

/**
 * The reconciliation of the orphaned running attempts (ADR-0052 section 7).
 *
 * A claimed run stores its worker attempt id and a heartbeat. When a worker dies the
 * attempt stays running, and nothing else would ever move it. The reconciliation
 * marks such an attempt failed, but only when two facts hold: the heartbeat is stale
 * and no BullMQ lock remains.
 *
 * The reconciliation takes the same global advisory lock the scan takes, so it never
 * races a scan that is still running. When the lock or the queue state cannot be
 * established, the attempt is left as it is: it stays visibly pending for the
 * operator instead of being guessed away.
 */

/** How long a heartbeat may be stale before an attempt counts as orphaned. */
export const WEB_SCAN_STALE_ATTEMPT_MS = 5 * 60 * 1000;

/** The maximum number of attempts one reconciliation looks at. */
export const WEB_SCAN_RECONCILE_BATCH = 50;

/**
 * Marks the orphaned running attempts failed.
 *
 * Returns the number of attempts it marked. Zero means nothing was touched: either
 * there was nothing orphaned, or the state could not be established and the attempts
 * were left pending.
 */
export async function reconcileOrphanedAttempts(
  deps: WebScanWorkerDeps & { queue: Queue<WebScanQueueData> },
  options?: { now?: Date | undefined; staleAfterMs?: number | undefined },
): Promise<number> {
  const now = options?.now ?? deps.now?.() ?? new Date();
  const staleAfterMs = options?.staleAfterMs ?? WEB_SCAN_STALE_ATTEMPT_MS;
  const staleBefore = new Date(now.getTime() - staleAfterMs);

  let lease: ScanLease;
  try {
    lease = await acquireScanLease({ pool: deps.pool });
  } catch (error) {
    // Another scan holds the lease: the attempt is probably alive. Leave it pending.
    deps.logger?.warn?.('The web scan reconciliation left the attempts pending', {
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return 0;
  }

  try {
    const stale = await deps.workerStore.listStaleRunningScans({
      staleBefore,
      limit: WEB_SCAN_RECONCILE_BATCH,
    });
    const orphaned: string[] = [];
    for (const entry of stale) {
      let locked: boolean;
      try {
        // The membership of the active list is not a lock: a job stays listed as active
        // while its lock is gone. The lock of BullMQ is a Redis key with an expiry, so
        // the lock of a job whose worker died is gone.
        locked = await isJobLocked(deps.queue, scanJobId(entry.scanId));
      } catch (error) {
        // The queue state cannot be established: fail closed and leave the attempt.
        deps.logger?.warn?.('The web scan job state could not be read', {
          scanId: entry.scanId,
          error: error instanceof Error ? error.name : 'unknown error',
        });
        continue;
      }
      if (locked) continue;
      orphaned.push(entry.scanId);
    }

    if (orphaned.length === 0) return 0;
    return await deps.workerStore.failOrphanedAttempts({
      scanIds: orphaned,
      staleBefore,
      now,
    });
  } finally {
    await lease.release();
  }
}

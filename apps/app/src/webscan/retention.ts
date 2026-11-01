import type { WebScanStore } from './store.js';
import type { WebScanWorkerStore } from './worker-store.js';

/**
 * The retention of the scanner (ADR-0052 section 11).
 *
 * The nightly retention job of the worker calls this. It does three things:
 *
 * - It restores the occurrences whose administrator resolution expired or was revoked,
 *   so a resolution that ends puts the finding back into the risk state.
 * - It archives the occurrences that were never proven fixed and that nobody evaluated
 *   since the horizon elapsed, and it prunes the tombstones a completed scan proved
 *   fixed.
 * - It deletes the expired scan snapshots and their evidence, keeping the last
 *   completed scan of every site as the comparison baseline.
 *
 * The occurrences, the exceptions, the authorization references, the alert delivery
 * records and the bounded episode state of a site are never deleted here: they outlive
 * the snapshot that produced them.
 */

/** The logger of the retention pass. */
export interface WebScanRetentionLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

/** The dependencies of the retention pass. */
export interface WebScanRetentionDeps {
  /** The shared store. */
  store: WebScanStore;
  /** The worker persistence. */
  workerStore: WebScanWorkerStore;
  /** The clock. */
  now?: (() => Date) | undefined;
  /** The logger. */
  logger?: WebScanRetentionLogger | undefined;
  /** The maximum number of sites the pass touches. */
  siteBatch?: number | undefined;
  /** The maximum number of snapshots the pass deletes. */
  scanBatch?: number | undefined;
}

/** What the retention pass did. */
export interface WebScanRetentionResult {
  /** The number of sites the pass touched. */
  sites: number;
  /** The number of snapshots the pass deleted. */
  prunedScans: number;
  /** The number of occurrences the pass restored. */
  restoredOccurrences: number;
  /** The number of occurrences the pass archived. */
  archivedOccurrences: number;
  /** The number of tombstones the pass pruned. */
  prunedTombstones: number;
  /** The number of sites the pass did not reach. */
  remainingSites: number;
}

const DAY_MS = 86_400_000;

/** The default number of sites one pass touches. */
export const WEB_SCAN_RETENTION_SITE_BATCH = 50;

/** The default number of snapshots one pass deletes. */
export const WEB_SCAN_RETENTION_SCAN_BATCH = 200;

/**
 * Runs one retention pass.
 *
 * The pass is bounded on purpose: it touches a limited number of sites and deletes a
 * limited number of snapshots, so a large backlog is worked through over several
 * nights instead of in one long transaction.
 */
export async function runWebScanRetention(
  deps: WebScanRetentionDeps,
): Promise<WebScanRetentionResult> {
  const now = deps.now ?? (() => new Date());
  const siteBatch = Math.max(1, deps.siteBatch ?? WEB_SCAN_RETENTION_SITE_BATCH);
  const scanBatch = Math.max(1, deps.scanBatch ?? WEB_SCAN_RETENTION_SCAN_BATCH);

  const settings = await deps.store.getSettings();
  const olderThan = new Date(now().getTime() - settings.retentionDays * DAY_MS);

  const sites = await deps.store.listSites();
  // The window moves by one batch per UTC day, so a platform with more sites than one batch
  // still reaches every site within ceil(sites / batch) nights, without a stored cursor.
  const start =
    sites.length <= siteBatch ? 0 : (Math.floor(now().getTime() / DAY_MS) * siteBatch) % sites.length;
  const batch = [...sites.slice(start), ...sites.slice(0, start)].slice(0, siteBatch);

  let restoredOccurrences = 0;
  let archivedOccurrences = 0;
  let prunedTombstones = 0;

  for (const site of batch) {
    // A resolution that expired or was revoked puts the finding back into the
    // outstanding state, under the same identity.
    restoredOccurrences += await deps.store.restoreExpiredExceptionOccurrences(site.id);
    // An occurrence that was never proven fixed and that nobody evaluated since the
    // horizon elapsed becomes a tombstone. It stays in the ledger and keeps blocking
    // its group.
    archivedOccurrences += await deps.store.archiveUnprovenOccurrences(site.id);
    // A tombstone a completed scan proved fixed is the only tombstone that goes.
    prunedTombstones += await deps.store.pruneProvenFixedTombstones(site.id);
  }

  // The snapshots go last: a tombstone is only pruned while a completed scan still
  // proves it fixed, so the proof has to outlive the snapshot that produced it.
  const prunedScans = await deps.workerStore.pruneExpiredScans({ olderThan, limit: scanBatch });

  await deps.workerStore.appendAuditSummary({
    actor: 'worker:retention',
    action: 'scan.retention',
    targetType: 'scanner',
    targetId: 'web-scan',
    after: {
      retentionDays: settings.retentionDays,
      sites: batch.length,
      remainingSites: Math.max(0, sites.length - batch.length),
      prunedScans,
      restoredOccurrences,
      archivedOccurrences,
      prunedTombstones,
    },
  });

  deps.logger?.info?.('The web scan retention pass ended', {
    sites: batch.length,
    prunedScans,
    restoredOccurrences,
    archivedOccurrences,
    prunedTombstones,
  });

  return {
    sites: batch.length,
    prunedScans,
    restoredOccurrences,
    archivedOccurrences,
    prunedTombstones,
    remainingSites: Math.max(0, sites.length - batch.length),
  };
}

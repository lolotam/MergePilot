import type { RecordWebScanOutcomeInput } from './store.js';
import type { WebScanScan, WebScanOutboxState } from './types.js';

/**
 * The persistence the scan worker needs on top of the shared store (ADR-0052 sections 7 and 11).
 *
 * The shared store owns the scanner's domain invariants. The worker needs a few
 * runtime capabilities that the store does not expose yet: the atomic claim of a queued
 * scan by one worker attempt, the heartbeat of that attempt, the attempt-fenced terminal
 * write, the reconciliation of orphaned attempts, the outbox and the pruning of expired
 * snapshots.
 *
 * Every implementation of this contract writes through the shared transactional and
 * audit helpers, so the worker never writes a state transition without its audit row
 * and never writes a state transition outside a transaction.
 */

/** How a fenced terminal write ended. */
export type WebScanTerminalWrite = 'recorded' | 'fenced' | 'already_terminal';

/** One outbox record that still has to be published. */
export interface WebScanOutboxEntry {
  scanId: string;
  siteId: string;
  trigger: 'manual' | 'scheduled';
  scheduledFor: Date | null;
  outboxState: WebScanOutboxState;
  createdAt: Date;
}

/** The input of a claim. */
export interface WebScanClaimInput {
  scanId: string;
  /** The id of the worker attempt that takes the scan. */
  attemptId: string;
  now: Date;
}

/** The input of a heartbeat. */
export interface WebScanHeartbeatInput {
  scanId: string;
  /** The attempt that owns the running scan. */
  attemptId: string;
  now: Date;
}

/** The input of a fenced terminal write. */
export type WebScanOutcomeAttemptInput = RecordWebScanOutcomeInput & {
  /** The attempt that owns the running scan. */
  attemptId: string;
  /** The moment the outcome is written. */
  now: Date;
};

/** The input of the snapshot pruning. */
export interface WebScanPruneInput {
  /** Scans created before this are expired. */
  olderThan: Date;
  /** The maximum number of scans to delete in one call. */
  limit: number;
}

/** The verified identity of a platform administrator. */
export interface WebScanAdministratorIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** The live state one outbound request needs. */
export interface WebScanLiveState {
  /** The kill switch. */
  paused: boolean;
  /** The administrator who authorized the site, with the current verification state. */
  administrator: WebScanAdministratorIdentity | null;
  /** The site was removed. */
  removed: boolean;
  /** The site has a current authorization reference. */
  authorized: boolean;
  /**
   * The current scope version of the site.
   *
   * A queued scan records the version it was queued under. A site whose scope or whose
   * schedule changed has a higher version, and the scan stops instead of running an
   * authorization that is no longer current.
   *
   * It is absent while the shared live read does not carry it. The worker reads the
   * version from the site row until it does.
   */
  scopeVersion?: number | undefined;
  /**
   * The identity of the user who gave the authorization the queued scan runs under,
   * with the current verification state.
   *
   * It is the identity of the original authorizer and not of the current one: a site
   * that was authorized again keeps its queued work, and that work stays bound to the
   * administrator that authorized it.
   *
   * It is absent while the shared live read does not carry it. The worker resolves it
   * from the audit log until it does.
   */
  authorizingAdministrator?: WebScanAdministratorIdentity | null | undefined;
  /**
   * Whether the running attempt still owns the scan row.
   *
   * It is absent while the shared live read does not carry it. A scan that lost its row
   * to a cancel stops instead of finishing a scan that nobody owns any more.
   */
  attemptOwned?: boolean | undefined;
}

/** The attempt whose ownership of a scan row is checked. */
export interface WebScanLiveAttempt {
  /** The scan the attempt runs. */
  scanId: string;
  /** The attempt that runs the scan. */
  attemptId: string;
}

/** The worker-facing persistence contract. */
export interface WebScanWorkerStore {
  /**
   * Reads the current identity of the administrator who authorized a site.
   *
   * The worker reads it again before the claim and before every request, so a revoked
   * administrator, an unverified email or a removed administrator stops the scan.
   */
  loadAdministratorIdentity(userId: string): Promise<WebScanAdministratorIdentity | null>;
  /**
   * Reads the live state one outbound request needs.
   *
   * The worker reads it before every request, so a closed kill switch, a removed site,
   * a revoked administrator, a changed scope version or a lost attempt stops the scan
   * before the next request leaves.
   *
   * The attempt is optional, so a read without a running attempt stays valid. When it
   * is given, the read also says whether the attempt still owns the scan row.
   */
  readLiveScanState(
    siteId: string,
    attempt?: WebScanLiveAttempt | undefined,
  ): Promise<WebScanLiveState | null>;
  /** Stops a queued scan without sending a single request. */
  stopQueuedScan(input: {
    scanId: string;
    reason: string;
    now: Date;
  }): Promise<'stopped' | 'not_queued' | 'fenced'>;
  /**
   * Atomically claims a queued scan for one worker attempt.
   *
   * Returns null when the scan is not claimable: it does not exist, it is already
   * running, or it already has a terminal state. A terminal scan is never executed
   * again.
   */
  claimScan(input: WebScanClaimInput): Promise<WebScanScan | null>;
  /** Refreshes the heartbeat of a running scan. Returns false when the attempt lost it. */
  heartbeatScan(input: WebScanHeartbeatInput): Promise<boolean>;
  /** Writes the terminal state of a scan, fenced by the attempt id. */
  recordScanOutcomeAttempt(actor: string, input: WebScanOutcomeAttemptInput): Promise<WebScanTerminalWrite>;
  /** Lists the running attempts whose heartbeat is stale. */
  listStaleRunningScans(input: { staleBefore: Date; limit: number }): Promise<WebScanOutboxEntry[]>;
  /** Marks the given orphaned running attempts failed. */
  failOrphanedAttempts(input: {
    scanIds: readonly string[];
    /** The heartbeat cutoff the attempt had to be older than. */
    staleBefore: Date;
    now: Date;
  }): Promise<number>;
  /** Lists the outbox records that still have to be published. */
  listPendingOutboxScans(limit: number): Promise<WebScanOutboxEntry[]>;
  /**
   * Lists the queued scans whose outbox record is already published.
   *
   * The dispatcher checks them against the queue, so a scan whose job vanished from
   * Redis is published again under the same job id.
   */
  listPublishedQueuedScans(limit: number): Promise<WebScanOutboxEntry[]>;
  /** Marks an outbox record as published. */
  markOutboxPublished(input: { scanId: string; now: Date }): Promise<boolean>;
  /** Marks an outbox record as unknown, so it is published again later. */
  markOutboxUnknown(input: { scanId: string; now: Date }): Promise<boolean>;
  /**
   * Queues the due occurrence of a site and advances its schedule.
   *
   * The site row is locked, so two ticks never queue the same occurrence. After the
   * due occurrence is claimed the schedule advances strictly to the next future
   * occurrence, so a downtime produces at most one catch-up scan per site.
   */
  enqueueDueScheduledScan(actor: string, input: { siteId: string; now: Date }): Promise<WebScanScan | null>;
  /** Deletes the expired scan snapshots, keeping the last completed scan of every site. */
  pruneExpiredScans(input: WebScanPruneInput): Promise<number>;
  /** Appends the audit summary of a maintenance pass. */
  appendAuditSummary(input: {
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    after: unknown;
  }): Promise<void>;
}

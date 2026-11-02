import type {
  CheckSwitches,
  Comparison,
  CoverageEntry,
  RetainedOccurrence,
  ScanLimits,
  ScanScope,
} from '@mergepilot/webscan';
import type {
  WebScanAlert,
  WebScanAlertEpisode,
  WebScanApprovedInstallation,
  WebScanAuditEntry,
  WebScanException,
  WebScanExceptionKind,
  WebScanExceptionReasonCategory,
  WebScanFinding,
  WebScanOccurrence,
  WebScanRepositoryBinding,
  WebScanScan,
  WebScanSchedule,
  WebScanSettings,
  WebScanSite,
} from './types.js';

/**
 * The focused store of the website security scanner (ADR-0052).
 *
 * The scanner is a platform-admin feature with its own tables, so it gets its own
 * store instead of growing the tenant-scoped `AppStore` with every platform method.
 * The routes, the worker and the retention job get this store injected.
 *
 * Every method that changes state writes its audit row in the same transaction, so a
 * failed audit insert rolls the change back.
 */

/** The store refused a request because it conflicts with the current state. */
export class WebScanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebScanConflictError';
  }
}

/** The scanner is paused, so nothing may be queued. */
export class WebScanPausedError extends Error {
  constructor() {
    super('The website security scanner is paused');
    this.name = 'WebScanPausedError';
  }
}

/** The site is not authorized to be scanned, or its authorization is stale. */
export class WebScanAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebScanAuthorizationError';
  }
}

/** The row does not exist. */
export class WebScanNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'WebScanNotFoundError';
  }
}

/** A change of the global settings. Only the given fields are written. */
export interface WebScanSettingsPatch {
  paused?: boolean;
  alertsEnabled?: boolean;
  limits?: Partial<ScanLimits>;
  checks?: CheckSwitches;
  defaultSchedule?: WebScanSchedule;
  retentionDays?: number;
  contact?: string;
  alertMinSeverity?: WebScanSettings['alertMinSeverity'];
  alertMinValidation?: WebScanSettings['alertMinValidation'];
  approvedInstallations?: WebScanApprovedInstallation[];
}

/** The input of a site registration. It carries a fresh authorization. */
export interface CreateWebScanSiteInput {
  hostname: string;
  baseUrl: string;
  ownerUserId: string;
  /** The authorized scope. A restored site never keeps the scope it had before. */
  scope: ScanScope;
  schedule?: WebScanSchedule | null;
  repository?: WebScanRepositoryBinding | null;
  /** Who confirmed the authorization. */
  authorizedBy: string;
}

/** The input of a site change. */
export interface UpdateWebScanSiteInput {
  scope?: ScanScope;
  schedule?: WebScanSchedule | null;
  repository?: WebScanRepositoryBinding | null;
  /** Who confirmed the authorization. */
  authorizedBy?: string;
}

/** The input of a manual scan request. */
export interface EnqueueManualWebScanInput {
  siteId: string;
  /** The administrator-generated idempotency key. */
  idempotencyKey: string;
  /** A scope override for this request only. */
  scope?: ScanScope;
  /** A check override for this request only. */
  checks?: CheckSwitches;
}

/** The input of a scheduled scan. */
export interface EnqueueScheduledWebScanInput {
  siteId: string;
  /** The slot the scan belongs to. */
  scheduledFor: Date;
  /**
   * The moment the schedule is evaluated.
   *
   * The schedule advances to its next occurrence strictly beyond this moment. It
   * defaults to the current time.
   */
  now?: Date;
}

/** The outcome of a manual enqueue. A replayed request reuses the existing scan. */
export interface EnqueueWebScanResult {
  scan: WebScanScan;
  /** True when the same idempotency key and the same request data were seen before. */
  replayed: boolean;
}

/** The outcome of an administrator stop: either the stop wrote, or it stayed out. */
export interface StopWebScanResult {
  scan: WebScanScan;
  /**
   * `stopped` when the row moved to its terminal state in this call, and
   * `already_terminal` when the scan already had a terminal state and nothing
   * was written.
   */
  outcome: 'stopped' | 'already_terminal';
}

/** The findings and the coverage a completed scan produced. */
export interface RecordWebScanOutcomeInput {
  scanId: string;
  siteId: string;
  status: 'completed' | 'stopped' | 'failed';
  stopReason?: string | null;
  failReason?: string | null;
  requests: number;
  pages: number;
  durationMs: number;
  findings: WebScanFinding[];
  coverage: CoverageEntry[];
  /** The occurrence transitions the comparison produced. */
  updates: WebScanOccurrenceUpdate[];
}

/** One transition of the retained ledger. */
export type WebScanOccurrenceUpdate =
  | {
      state: 'outstanding' | 'fixed';
      finding: {
        occurrenceKey: string;
        targetKey: string;
        issueKey: string;
        checkId: string;
        checkVersion: number;
        issueId: string;
        subject: string;
        severity: string;
        validation: string;
        confidence: string;
        safeLocation: string;
        evidenceHash: string;
        evidence: unknown;
        comparison: Comparison;
      };
    }
  | {
      state: 'archived';
      identity: {
        occurrenceKey: string;
        targetKey: string;
        issueKey: string;
        checkId: string;
        checkVersion: number;
        issueId: string;
        subject: string;
        severity: string;
        validation: string;
        confidence: string;
        safeLocation: string;
        evidenceHash: string;
      };
      archiveReason: 'unobserved_retention' | 'retired_catalogue';
    };

/** The input of an administrator resolution. */
export interface CreateWebScanExceptionInput {
  siteId: string;
  occurrenceKey: string;
  evidenceHash: string;
  kind: WebScanExceptionKind;
  reasonCategory: WebScanExceptionReasonCategory;
  /** The free-form reason. It is never published. */
  reason: string;
  /** When the resolution stops applying. Null means it never expires. */
  expiresAt?: Date | null;
}

/** The input of an alert record. */
export interface UpsertWebScanAlertInput {
  siteId: string;
  issueKey: string;
  episodeKey: string;
  repositoryId: number;
  installationId: number;
  githubAccountId: number;
  issueNumber?: number | null;
  deliveryMarker: string;
  deliveryState: WebScanAlert['deliveryState'];
  issueState: WebScanAlert['issueState'];
  occurrenceKeys: string[];
}

/** The store of the website security scanner. */
export interface WebScanStore {
  // -- The global settings -------------------------------------------------
  getSettings(): Promise<WebScanSettings>;
  updateSettings(actor: string, patch: WebScanSettingsPatch): Promise<WebScanSettings>;

  // -- The sites ------------------------------------------------------------
  listSites(options?: { includeRemoved?: boolean }): Promise<WebScanSite[]>;
  getSite(siteId: string): Promise<WebScanSite | null>;
  getSiteByHostname(hostname: string): Promise<WebScanSite | null>;
  /**
   * Registers a site. A hostname of a removed site restores its original row and id
   * when the same owner registers it again; another owner gets a conflict.
   */
  createSite(actor: string, input: CreateWebScanSiteInput): Promise<WebScanSite>;
  updateSite(actor: string, siteId: string, input: UpdateWebScanSiteInput): Promise<WebScanSite>;
  /** A soft removal: the queued scans stop and the authorization is invalidated. */
  removeSite(actor: string, siteId: string): Promise<WebScanSite>;

  // -- The scans ------------------------------------------------------------
  enqueueManualScan(actor: string, input: EnqueueManualWebScanInput): Promise<EnqueueWebScanResult>;
  enqueueScheduledScan(actor: string, input: EnqueueScheduledWebScanInput): Promise<WebScanScan>;
  getScan(scanId: string): Promise<WebScanScan | null>;
  listScans(siteId: string): Promise<WebScanScan[]>;
  /**
   * Cancels a queued or running scan on an administrator request.
   *
   * A queued scan becomes terminal right away; a running scan is marked stopped while
   * the worker still owns its attempt, and the worker's own terminal write is then
   * refused by the attempt fence. The stop state and its audit row are written in one
   * transaction. A scan that already has a terminal state is returned unchanged and
   * nothing is written.
   */
  stopScan(actor: string, scanId: string): Promise<StopWebScanResult>;

  // -- The retained ledger --------------------------------------------------
  /** The retained occurrences of a site, in the shape the comparison needs. */
  listRetainedOccurrences(siteId: string): Promise<RetainedOccurrence[]>;
  listOccurrences(siteId: string): Promise<WebScanOccurrence[]>;
  /** Writes the terminal state, the findings, the coverage and the ledger together. */
  recordScanOutcome(actor: string, input: RecordWebScanOutcomeInput): Promise<void>;
  /**
   * Archives the occurrences whose retention horizon elapsed and that no completed
   * scan evaluated since. Returns how many rows became tombstones.
   */
  archiveUnprovenOccurrences(siteId: string): Promise<number>;
  /** Deletes the tombstones a completed scan proved Fixed. */
  pruneProvenFixedTombstones(siteId: string): Promise<number>;

  // -- The administrator resolutions ---------------------------------------
  listExceptions(siteId: string): Promise<WebScanException[]>;
  /** The resolutions that apply at the given moment. */
  listLiveExceptions(siteId: string, at: Date): Promise<WebScanException[]>;
  createException(actor: string, input: CreateWebScanExceptionInput): Promise<WebScanException>;
  revokeException(actor: string, exceptionId: string): Promise<WebScanException>;
  /** Restores the tombstones whose resolution expired or was revoked. */
  restoreExpiredExceptionOccurrences(siteId: string): Promise<number>;

  // -- The alerts -----------------------------------------------------------
  listAlerts(siteId: string): Promise<WebScanAlert[]>;
  /**
   * Writes the delivery state of an alert.
   *
   * The state and its audit row are written in one transaction.
   */
  upsertAlert(input: UpsertWebScanAlertInput): Promise<WebScanAlert>;
  /** Replaces the bounded episode state of a site. */
  setSiteAlertEpisodes(actor: string, siteId: string, episodes: WebScanAlertEpisode[]): Promise<void>;

  // -- The audit log --------------------------------------------------------
  /** The audit log is append-only: there is no update and no delete. */
  listAudit(options?: {
    limit?: number;
    targetType?: string;
    targetId?: string;
  }): Promise<WebScanAuditEntry[]>;
}

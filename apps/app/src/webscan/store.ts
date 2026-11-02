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
  WebScanScanFinding,
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

/**
 * How many approved installations the platform holds at most.
 *
 * The list is a bound, not a queue: an administrator approves the installations
 * of the accounts their own sites live in, and a bounded list keeps the settings
 * row small and auditable.
 */
export const WEB_SCAN_MAX_APPROVED_INSTALLATIONS = 20;

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
  /**
   * The moment of the snapshot the change was computed from.
   *
   * It is a guard and not a written field: the store refuses the change when the
   * locked row moved since that snapshot, so two changes that were computed from
   * the same snapshot can never be merged into a combination neither of them saw.
   */
  expectedUpdatedAt?: Date;
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

/**
 * One page of the audit log and the number of rows the log holds.
 *
 * The page and the total come from one snapshot of the log, so they always
 * describe the same version of it.
 */
export interface WebScanAuditPage {
  /** The rows of the page, newest first. */
  entries: WebScanAuditEntry[];
  /** The number of rows the log holds. */
  total: number;
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
  /**
   * Approves one installation of the App for one administrator.
   *
   * The approval is written only after GitHub proved that the administrator
   * reaches the installation, that it is not suspended and that it grants the
   * App `issues: write` (ADR-0052 section 8). The account id is the one GitHub
   * reports, never one the caller supplies.
   *
   * The entry of one administrator and installation is written once: an approval
   * of the same installation replaces the old entry, and the list never grows
   * past its bound. The entry and its audit row are written in one transaction.
   */
  approveInstallation(
    actor: string,
    entry: WebScanApprovedInstallation,
  ): Promise<WebScanSettings>;
  /**
   * Removes the approval of one installation of one administrator.
   *
   * Nothing else is detached here: a site that points at the installation keeps
   * its binding, and the delivery of an alert to it fails closed because the
   * approval is gone.
   */
  revokeInstallationApproval(
    actor: string,
    adminUserId: string,
    installationId: number,
  ): Promise<WebScanSettings>;

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
   * The findings of one scan, in a stable order.
   *
   * A scan keeps its own findings: the detail and the report of a scan show what
   * that scan found and not what the ledger of the site holds now.
   */
  listScanFindings(scanId: string): Promise<WebScanScanFinding[]>;
  /**
   * Cancels a queued or running scan on an administrator request.
   *
   * A queued scan becomes terminal right away; a running scan is marked stopped and keeps
   * its attempt id until the cancelled attempt reports its counters once, so the worker
   * no longer owns it and stops before its next request. The cancelled attempt's terminal
   * write changes neither the state nor the results; it may add its request, page and
   * duration counters once, and that write clears the attempt id, so the attempt can
   * never write the counters a second time. The stop state and its audit row are
   * written in one transaction. A scan that already has a terminal state is returned
   * unchanged and nothing is written.
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
    /** How many rows to skip. The newest rows come first. */
    offset?: number;
    targetType?: string;
    targetId?: string;
  }): Promise<WebScanAuditEntry[]>;
  /**
   * The number of rows of the audit log.
   *
   * The count is a query of its own, so a page never has to read the whole log
   * to know how many rows there are.
   */
  countAudit(options?: { targetType?: string; targetId?: string }): Promise<number>;
  /**
   * One page of the audit log and the number of rows the log holds.
   *
   * The page and the total are read from one snapshot of the log, so a row that is
   * appended between two reads can never make the page and the total disagree: a
   * page never holds more rows than the log has.
   */
  listAuditPage(options?: {
    limit?: number;
    /** How many rows to skip. The newest rows come first. */
    offset?: number;
    targetType?: string;
    targetId?: string;
  }): Promise<WebScanAuditPage>;
  /**
   * One audit row by its id.
   *
   * The id is how a scan names the authorization it runs under, so the row is read
   * by its id: a page of the log is not a reliable place to look for it.
   */
  getAuditEntry(auditId: string): Promise<WebScanAuditEntry | null>;
}

import type {
  ArchiveReason,
  CheckId,
  CheckSwitches,
  Comparison,
  Confidence,
  CoverageEntry,
  ExceptionKind,
  OccurrenceState,
  RetainedOccurrence,
  ScanLimits,
  ScanScope,
  Severity,
  Validation,
} from '@mergepilot/webscan';

/**
 * The app-side types of the website security scanner (ADR-0052).
 *
 * These types describe what the store persists. They are platform-global: a
 * scan, a site and an audit row belong to the platform, not to a workspace.
 */

/** How often a site is scanned. */
export type WebScanFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

/**
 * A scan schedule. The fields that matter depend on the frequency.
 *
 * This is the one persisted shape of a schedule: the store normalizes every rule
 * through `parseSchedule` before it is written, so a saved rule is always evaluable
 * without any further guesswork.
 */
export interface WebScanSchedule {
  frequency: WebScanFrequency;
  /** 0 is Sunday. Used by the weekly and biweekly frequencies. */
  weekday?: number;
  /** 1 to 31. Used by the monthly frequency. A day past the end of a month is clamped. */
  dayOfMonth?: number;
  hour: number;
  minute: number;
  enabled: boolean;
  /**
   * The local calendar date the rule is anchored to, as `YYYY-MM-DD`.
   *
   * The biweekly frequency is only evaluable with an anchor: it picks every second
   * occurrence of a weekday, and the anchor decides which one comes first. The store
   * writes the anchor of a valid biweekly rule, so a saved rule never loses it.
   */
  anchorDate?: string;
}

/** One approved (administrator, installation, account) triple. */
export interface WebScanApprovedInstallation {
  adminUserId: string;
  installationId: number;
  githubAccountId: number;
}

/** The global settings of the scanner. */
export interface WebScanSettings {
  /** The kill switch. A paused scanner queues nothing. */
  paused: boolean;
  /** Whether notifications may be delivered. */
  alertsEnabled: boolean;
  limits: ScanLimits;
  checks: CheckSwitches;
  defaultSchedule: WebScanSchedule;
  /** How long a retained occurrence and a scan snapshot survive. */
  retentionDays: number;
  /** The contact shown in a notification. It is never a credential. */
  contact: string;
  alertMinSeverity: Severity;
  alertMinValidation: Validation;
  approvedInstallations: WebScanApprovedInstallation[];
  updatedAt: Date;
  updatedBy: string | null;
}

/** The optional repository a site reports into. */
export interface WebScanRepositoryBinding {
  owner: string;
  name: string;
  repositoryId: number;
  installationId: number;
  githubAccountId: number;
}

/** The authorization that allows scanning a site. */
export interface WebScanSiteAuthorization {
  auditId: string | null;
  authorizedBy: string | null;
  authorizedAt: Date | null;
  /** Bumped on every scope or schedule change. A queued scan records the version it ran under. */
  scopeVersion: number;
}

/** The state of one alert episode of a site. */
export interface WebScanAlertEpisode {
  episodeKey: string;
  issueKey: string;
  state: 'open' | 'closed';
  occurrenceKeys: string[];
  lastChangedAt: string;
}

/** A registered site. */
export interface WebScanSite {
  id: string;
  hostname: string;
  baseUrl: string;
  ownerUserId: string;
  repository: WebScanRepositoryBinding | null;
  /** The authorized scope of the site. */
  scope: ScanScope;
  schedule: WebScanSchedule | null;
  authorization: WebScanSiteAuthorization;
  /** The bounded episode state. It lives on the site, not on a scan snapshot. */
  alertEpisodes: WebScanAlertEpisode[];
  /**
   * The coverage of the last completed scan. It lives on the site, not on a scan snapshot,
   * so the current coverage of a site survives the expiry of that snapshot.
   */
  lastCoverage: CoverageEntry[] | null;
  /** The scan that produced the retained coverage, when there is one. */
  lastCoverageScanId: string | null;
  /** When the retained coverage was recorded. */
  lastCoverageAt: Date | null;
  nextRunAt: Date | null;
  lastScanAt: Date | null;
  /** A removed site keeps its row, its history, its identity key and its exceptions. */
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The lifecycle of a scan. */
export type WebScanStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

/** How a scan was queued. */
export type WebScanTrigger = 'manual' | 'scheduled';

/** The state of the outbox that publishes a queued scan. */
export type WebScanOutboxState = 'pending' | 'published' | 'unknown';

/** A scan row. */
export interface WebScanScan {
  id: string;
  siteId: string;
  trigger: WebScanTrigger;
  status: WebScanStatus;
  scheduledFor: Date | null;
  idempotencyKey: string | null;
  outboxState: WebScanOutboxState;
  attemptId: string | null;
  heartbeatAt: Date | null;
  stopReason: string | null;
  failReason: string | null;
  requests: number;
  pages: number;
  durationMs: number;
  effectiveSettings: Record<string, unknown>;
  coverageSummary: CoverageEntry[] | null;
  authorizationAuditId: string | null;
  scopeVersion: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One finding of one scan. */
export interface WebScanFinding {
  id: string;
  scanId: string;
  siteId: string;
  issueKey: string;
  occurrenceKey: string;
  targetKey: string;
  checkId: CheckId;
  checkVersion: number;
  issueId: string;
  subject: string;
  severity: Severity;
  validation: Validation;
  confidence: Confidence;
  safeLocation: string;
  evidence: unknown | null;
  evidenceHash: string;
  comparison: Comparison;
}

/** One retained occurrence of the ledger. */
export interface WebScanOccurrence {
  id: string;
  siteId: string;
  occurrenceKey: string;
  targetKey: string;
  issueKey: string;
  checkId: CheckId;
  checkVersion: number;
  issueId: string;
  subject: string;
  severity: Severity;
  validation: Validation;
  confidence: Confidence;
  safeLocation: string;
  evidenceHash: string;
  evidence: unknown | null;
  state: OccurrenceState;
  archiveReason: ArchiveReason | null;
  comparison: Comparison | null;
  lastObservedAt: Date;
  lastCompletedScanId: string | null;
  exceptionId: string | null;
  notificationEpisodeRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Why an administrator resolved an occurrence. */
export type WebScanExceptionKind = ExceptionKind;

/** The reason category of an administrator resolution. */
export type WebScanExceptionReasonCategory =
  | 'not_applicable'
  | 'already_mitigated'
  | 'accepted_risk'
  | 'out_of_scope'
  | 'third_party_dependency'
  | 'test_environment';

/** One administrator resolution. */
export interface WebScanException {
  id: string;
  siteId: string;
  occurrenceKey: string;
  evidenceHash: string;
  kind: WebScanExceptionKind;
  reasonCategory: WebScanExceptionReasonCategory;
  /** The free-form reason. It is never published. */
  reason: string;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** One delivery record of an alert. */
export interface WebScanAlert {
  id: string;
  siteId: string;
  issueKey: string;
  episodeKey: string;
  repositoryId: number;
  installationId: number;
  githubAccountId: number;
  issueNumber: number | null;
  deliveryMarker: string;
  deliveryState: 'pending' | 'sent' | 'unknown' | 'closed';
  issueState: 'open' | 'closed' | 'unknown';
  occurrenceKeys: string[];
  lastDeliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One audit row. The log is append-only. */
export interface WebScanAuditEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: Date;
}

/** The retained ledger of one site, as the comparison needs it. */
export type WebScanRetainedLedger = readonly RetainedOccurrence[];

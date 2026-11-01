/**
 * Shared contracts for the website security scanner.
 *
 * ADR-0052 is the design spec. This package owns crawling, deterministic
 * checks, comparison and report rendering, and it never imports from `apps/`
 * or `packages/engine` (ADR-0001). The app injects transport, storage, queueing
 * and per-site identity key management.
 *
 * Types that describe a scan result live here as well, because the app stores
 * them and the dashboard renders them. Every field below is safe to persist:
 * raw URLs, query values and response bodies never enter this contract.
 */

/** The six catalogue checks of ADR-0052 section 3. */
export type CheckId = 'headers' | 'cookies' | 'transport' | 'disclosure' | 'files' | 'active';

/** Validation state. A finding is never promoted beyond its evidence. */
export type Validation = 'Confirmed' | 'Likely' | 'Indicator' | 'Informational';

/** Comparison state against the site's last completed scan. */
export type Comparison = 'New' | 'Unchanged' | 'Fixed' | 'Not checked';

/** Severity is fixed per issue in the check catalogue. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Confidence in the observation, independent of the validation ceiling. */
export type Confidence = 'high' | 'medium' | 'low';

/** Per-check on/off switches, globally and per site. */
export type CheckSwitches = Record<CheckId, boolean>;

/**
 * Effective scan limits in their stored units. Counts, rates, byte sizes and
 * durations are finite positive integers; the documented bounds live in
 * `settings.ts`.
 */
export interface ScanLimits {
  /** Maximum outbound requests, including retries and redirect hops. */
  maxRequests: number;
  /** Maximum crawled pages. */
  maxPages: number;
  /** Maximum separately authorized parameterized links for active probes. */
  maxActiveLinks: number;
  /** Requests per second, paced one request at a time. */
  requestsPerSecond: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum response body size in bytes. */
  maxResponseBytes: number;
  /** Whole-scan deadline in milliseconds. */
  totalTimeoutMs: number;
}

/** A crawl path rule. Prefixes end at a path-segment boundary. */
export interface PathRule {
  path: string;
  kind: 'exact' | 'prefix';
}

/** An exact path plus the parameter names authorized on it. */
export interface ParameterRule {
  path: string;
  parameters: readonly string[];
}

/**
 * The authorized read-only scope of one site. Every list is empty by default:
 * an empty allow list authorizes no crawl link.
 */
export interface ScanScope {
  /** Canonical hostname of the site. Matching is exact, never a suffix. */
  hostname: string;
  /** Query-free base URL of the site. */
  baseUrl: string;
  /** Crawl path rules. Empty by default. */
  crawlPaths: readonly PathRule[];
  /** Blocked crawl paths. A denial always wins over an allow rule. */
  blockedPaths: readonly PathRule[];
  /** Parameterized link authorizations, by exact path and parameter names. */
  parameterizedPaths: readonly ParameterRule[];
  /** Active probe authorizations, by exact path and parameter names. */
  activePaths: readonly ParameterRule[];
  /** Extra same-host exposed-file paths. */
  extraFilePaths: readonly string[];
}

/** Everything a scan needs that is not transport or clock. */
export interface ScanInput {
  scope: ScanScope;
  limits: ScanLimits;
  checks: CheckSwitches;
  /** Contact string advertised in the scanner User-Agent. */
  contact: string;
}

/** Bounded progress reported to the dashboard. Carries counts only. */
export interface ScanProgress {
  requests: number;
  pages: number;
  elapsedMs: number;
  phase: 'crawl' | 'checks' | 'complete';
}

/**
 * The injected boundaries of one scan.
 *
 * The injected `fetch` must apply the site's validated hostname, the pinned
 * address, the size and time caps and the live authorization checks. The
 * identity functions are app-supplied per-site HMAC functions; their raw inputs
 * never leave the worker process.
 */
export interface ScanDependencies {
  /**
   * Requests contain transient raw URLs. Implementations must never log them.
   * HEAD is allowed by the transport rules, but exposed-file checks always use
   * the size-capped GET (ADR-0052 section 3).
   */
  fetch: (url: string, init: { method: 'GET' | 'HEAD'; signal: AbortSignal }) => Promise<Response>;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onProgress: (progress: ScanProgress) => void;
  /** Identity of the original baseline URL, never of a mutated probe. */
  identifyTarget: (baselineUrl: string) => string;
  /** Identity of one occurrence of a check issue on a target. */
  identifyOccurrence: (input: {
    targetKey: string;
    checkId: CheckId;
    issueId: string;
    subject: string;
  }) => string;
}

/** One safe finding for one occurrence. */
export interface OccurrenceFinding {
  occurrenceKey: string;
  targetKey: string;
  checkId: CheckId;
  checkVersion: number;
  issueKey: string;
  issueId: string;
  subject: string;
  severity: Severity;
  validation: Validation;
  confidence: Confidence;
  safeLocation: string;
  evidenceHash: string;
  /**
   * Only catalogue-approved, structurally sanitized facts.
   *
   * `null` is an explicit state, not an empty finding: it means retention
   * pruned the evidence payload and only the identity plus the exception-pinned
   * evidenceHash remain (an outstanding row restored from an archived
   * tombstone).
   */
  evidence: Readonly<Record<string, string | number | boolean>> | null;
}

/**
 * The subjects a coverage row covers.
 *
 * A target can carry more than one subject: a link with two parameters is one
 * target but two subjects. The scope says which subjects the evaluated issue
 * facts of the row belong to, so a consumer can ask for the proof of one
 * subject without reading a raw URL.
 *
 * - `complete`: the check evaluated the issue on the whole target, so the row
 *   covers every subject of that target.
 * - `restricted`: the check evaluated the issue on the named subjects only. The
 *   row never covers another subject. The names are parameter names, never
 *   values, so no query secret can reach a coverage row.
 *
 * A row without a scope covers no subject: its scope is unknown, and it can
 * never supply a successful negative for one.
 */
export type CoverageSubjectScope =
  | { readonly kind: 'complete' }
  | { readonly kind: 'restricted'; readonly subjects: readonly string[] };

/** What a check could and could not establish for one target. */
export interface CoverageEntry {
  targetKey: string;
  checkId: CheckId;
  checkVersion: number;
  evaluatedIssueIds: readonly string[];
  outcome: 'checked' | 'error' | 'not-visited';
  reason?:
    | 'redirect_out_of_scope'
    | 'http_probe_unreachable'
    | 'disabled'
    | 'not_visited'
    | 'target_error';
  /**
   * The subjects the evaluated issue ids of this row cover.
   *
   * Absent means unknown: a row without a scope cannot supply a successful
   * negative for any subject. A restricted scope names the subjects only, never
   * their values.
   */
  subjectScope?: CoverageSubjectScope;
}

/** Why a bounded scan stopped before its natural end. */
export type ScanStopReason =
  | 'request_limit'
  | 'time_limit'
  | 'rate_limited'
  | 'cancelled'
  | 'kill_switch'
  | 'authorization_revoked'
  | 'lease_lost';

/** Why a scan failed. */
export type ScanFailureReason = 'target_error' | 'transport_error' | 'policy_violation' | 'worker_lost';

/** The observation of one scan, independent of its terminal status. */
export interface ScanObservationData {
  partialCoverage: boolean;
  requests: number;
  pages: number;
  durationMs: number;
  findings: readonly OccurrenceFinding[];
  coverage: readonly CoverageEntry[];
}

/** The terminal result of one scan. */
export type ScanObservation = ScanObservationData &
  (
    | { status: 'completed'; reason?: never }
    | { status: 'stopped'; reason: ScanStopReason }
    | { status: 'failed'; reason: ScanFailureReason }
  );

/**
 * The retained identity of an occurrence whose evidence body was pruned.
 *
 * It carries every safe finding field except `evidence`, so a tombstone can be
 * restored or proven Fixed later without fabricating a value.
 */
export interface RetainedOccurrenceIdentity {
  occurrenceKey: string;
  targetKey: string;
  checkId: CheckId;
  checkVersion: number;
  issueKey: string;
  issueId: string;
  subject: string;
  severity: Severity;
  validation: Validation;
  confidence: Confidence;
  safeLocation: string;
  evidenceHash: string;
}

/** The state of an occurrence in the retained ledger. */
export type OccurrenceState = 'outstanding' | 'fixed' | 'archived';

/**
 * Why an occurrence was archived.
 *
 * `unobserved_retention` is the retention horizon of ADR-0052 section 11: the
 * occurrence was never proven fixed and was not observed any more. It is a
 * historical Not checked state, never a remediation.
 *
 * `retired_catalogue` marks an occurrence whose immutable issue id left the
 * catalogue. A retired id is never Fixed, and a version change never retires
 * an id by itself.
 */
export type ArchiveReason = 'unobserved_retention' | 'retired_catalogue';

/** A retained occurrence row: outstanding, fixed, or an archival tombstone. */
export type RetainedOccurrence =
  | { finding: OccurrenceFinding; state: 'outstanding' }
  | { finding: OccurrenceFinding; state: 'fixed' }
  | {
      identity: RetainedOccurrenceIdentity;
      state: 'archived';
      archiveReason: ArchiveReason;
    };

/**
 * One change of the retained ledger.
 *
 * An `outstanding` update carries the finding that was observed. A `fixed`
 * update carries the finding of the occurrence that was proven absent. An
 * `archived` update carries the retained identity only: an archived row has no
 * evidence body, and nothing is ever fabricated for it.
 */
export type ComparisonUpdate =
  | { finding: OccurrenceFinding; comparison: Comparison; state: 'outstanding' }
  | { finding: OccurrenceFinding; comparison: Comparison; state: 'fixed' }
  | {
      identity: RetainedOccurrenceIdentity;
      comparison: 'Not checked';
      state: 'archived';
      archiveReason: ArchiveReason;
    };

/** The outcome of comparing a current observation against retained state. */
export interface ComparisonResult {
  mayBecomeBaseline: boolean;
  updates: readonly ComparisonUpdate[];
}

/**
 * The kind of an administrator resolution (ADR-0052 section 9).
 *
 * The kind is a closed vocabulary. The free-form reason of a resolution stays
 * in the dashboard and in the audit log, and it never enters a package
 * contract, a report or an export.
 */
export type ExceptionKind = 'accepted' | 'false_positive';

/**
 * One administrator resolution, as the package sees it.
 *
 * A resolution applies only while the occurrence key and the evidence hash
 * both match and the resolution has not expired. The package never reads a
 * reason, a reason category or a revocation flag: the caller passes the
 * resolutions that are live at the given moment.
 */
export interface ScanException {
  /** The occurrence the resolution covers. */
  readonly occurrenceKey: string;
  /** The evidence hash the resolution is pinned to. */
  readonly evidenceHash: string;
  readonly kind: ExceptionKind;
  /** Epoch milliseconds, or null when the resolution never expires. */
  readonly expiresAt: number | null;
}

/**
 * One occurrence as the display layer sees it.
 *
 * The record carries the safe metadata of the occurrence, its state in the
 * retained ledger and its comparison against the last scan. It never carries a
 * raw URL, a query value or a response body.
 */
export interface OccurrenceRecord {
  readonly occurrenceKey: string;
  readonly targetKey: string;
  readonly issueKey: string;
  readonly checkId: CheckId;
  readonly issueId: string;
  readonly subject: string;
  readonly severity: Severity;
  readonly validation: Validation;
  readonly confidence: Confidence;
  readonly safeLocation: string;
  readonly evidenceHash: string;
  /** `null` means the evidence body was pruned, never an empty finding. */
  readonly evidence: Readonly<Record<string, string | number | boolean>> | null;
  readonly state: OccurrenceState;
  readonly comparison: Comparison;
  /** The reason of an archived occurrence. */
  readonly archiveReason?: ArchiveReason;
}

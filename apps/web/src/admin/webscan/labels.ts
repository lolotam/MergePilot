import type {
  WebScanCoverageEntryDto,
  WebScanExceptionDto,
  WebScanOccurrenceDto,
  WebScanScanStatus,
} from '@mergepilot/app/contract';
import type { I18nKey } from '../../i18n/ar.js';

/**
 * The labels of the scanner values (ADR-0052 section 12).
 *
 * Every label of the area comes from the dictionaries, in both languages. The
 * maps keep the value of the contract and the key of the dictionary apart, so
 * a new value in the contract cannot reach the page without a label.
 */

/** The dictionary key of every severity. */
export const SEVERITY_KEYS = {
  critical: 'webscanSeverityCritical',
  high: 'webscanSeverityHigh',
  medium: 'webscanSeverityMedium',
  low: 'webscanSeverityLow',
  info: 'webscanSeverityInfo',
} as const satisfies Record<WebScanOccurrenceDto['severity'], string>;

/** The dictionary key of every validation state. */
export const VALIDATION_KEYS = {
  Confirmed: 'webscanValidationConfirmed',
  Likely: 'webscanValidationLikely',
  Indicator: 'webscanValidationIndicator',
  Informational: 'webscanValidationInformational',
} as const satisfies Record<WebScanOccurrenceDto['validation'], string>;

/** The dictionary key of every confidence. */
export const CONFIDENCE_KEYS = {
  high: 'webscanConfidenceHigh',
  medium: 'webscanConfidenceMedium',
  low: 'webscanConfidenceLow',
} as const satisfies Record<WebScanOccurrenceDto['confidence'], string>;

/** The dictionary key of every comparison state. */
export const COMPARISON_KEYS = {
  New: 'webscanComparisonNew',
  Unchanged: 'webscanComparisonUnchanged',
  Fixed: 'webscanComparisonFixed',
  'Not checked': 'webscanComparisonNotChecked',
} as const satisfies Record<NonNullable<WebScanOccurrenceDto['comparison']>, string>;

/** The dictionary key of every scan status. */
export const SCAN_STATUS_KEYS = {
  queued: 'webscanScanQueued',
  running: 'webscanScanRunning',
  completed: 'webscanScanCompleted',
  stopped: 'webscanScanStopped',
  failed: 'webscanScanFailed',
} as const satisfies Record<WebScanScanStatus, string>;

/** The dictionary key of every coverage outcome. */
export const COVERAGE_OUTCOME_KEYS = {
  checked: 'webscanCoverageChecked',
  error: 'webscanCoverageError',
  'not-visited': 'webscanCoverageNotVisited',
} as const satisfies Record<WebScanCoverageEntryDto['outcome'], string>;

/** The dictionary key of every coverage reason. */
export const COVERAGE_REASON_KEYS = {
  redirect_out_of_scope: 'webscanCoverageReasonRedirect',
  http_probe_unreachable: 'webscanCoverageReasonProbe',
  disabled: 'webscanCoverageReasonDisabled',
  not_visited: 'webscanCoverageReasonNotVisited',
  target_error: 'webscanCoverageReasonTargetError',
} as const satisfies Record<NonNullable<WebScanCoverageEntryDto['reason']>, string>;

/** The dictionary key of every kind of exception. */
export const EXCEPTION_KIND_KEYS = {
  accepted: 'webscanExceptionKindAccepted',
  false_positive: 'webscanExceptionKindFalsePositive',
} as const satisfies Record<WebScanExceptionDto['kind'], string>;

/** The dictionary key of every reason category of an exception. */
export const EXCEPTION_CATEGORY_KEYS = {
  not_applicable: 'webscanCategoryNotApplicable',
  already_mitigated: 'webscanCategoryAlreadyMitigated',
  accepted_risk: 'webscanCategoryAcceptedRisk',
  out_of_scope: 'webscanCategoryOutOfScope',
  third_party_dependency: 'webscanCategoryThirdParty',
  test_environment: 'webscanCategoryTestEnvironment',
} as const satisfies Record<WebScanExceptionDto['reasonCategory'], string>;

/** The order of the severities, from the strongest to the weakest. */
export const SEVERITY_ORDER: readonly WebScanOccurrenceDto['severity'][] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** The dictionary key of every check of the catalogue (ADR-0052 section 3). */
export const CHECK_KEYS = {
  headers: 'webscanCheckHeaders',
  cookies: 'webscanCheckCookies',
  transport: 'webscanCheckTransport',
  disclosure: 'webscanCheckDisclosure',
  files: 'webscanCheckFiles',
  active: 'webscanCheckActive',
} as const satisfies Record<WebScanOccurrenceDto['checkId'], string>;

/**
 * The dictionary key of every reason a scan ended with.
 *
 * The reasons are a fixed catalogue of codes (ADR-0052 section 7). The code
 * itself never reaches the page: the dashboard shows the dictionary of the
 * code, and a code it does not know shows nothing at all.
 */
export const SCAN_REASON_KEYS = {
  request_limit: 'webscanReasonRequestLimit',
  time_limit: 'webscanReasonTimeLimit',
  rate_limited: 'webscanReasonRateLimited',
  cancelled: 'webscanReasonCancelled',
  kill_switch: 'webscanReasonKillSwitch',
  authorization_revoked: 'webscanReasonAuthorizationRevoked',
  lease_lost: 'webscanReasonLeaseLost',
  target_error: 'webscanReasonTargetError',
  transport_error: 'webscanReasonTransportError',
  policy_violation: 'webscanReasonPolicyViolation',
  worker_lost: 'webscanReasonWorkerLost',
  site_missing: 'webscanReasonSiteMissing',
  site_removed: 'webscanReasonSiteRemoved',
  scope_changed: 'webscanReasonScopeChanged',
  attempt_lost: 'webscanReasonAttemptLost',
  job_lock_lost: 'webscanReasonJobLockLost',
  shutdown: 'webscanReasonShutdown',
  settings_unreadable: 'webscanReasonSettingsUnreadable',
  contact_unusable: 'webscanReasonContactUnusable',
  identity_key_missing: 'webscanReasonIdentityKeyMissing',
  runner_error: 'webscanReasonRunnerError',
} as const satisfies Record<string, string>;

/**
 * The dictionary key of the reason a scan ended with.
 *
 * An unknown code has no label: the dashboard never shows a raw value of the
 * server, so a reason it cannot name is left out instead of being printed.
 */
export function scanReasonKey(reason: string | null): I18nKey | undefined {
  if (reason === null) return undefined;
  return SCAN_REASON_KEYS[reason as keyof typeof SCAN_REASON_KEYS];
}

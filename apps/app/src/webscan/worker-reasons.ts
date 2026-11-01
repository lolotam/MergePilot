import { ScanStopError } from '@mergepilot/webscan';
import type { WebScanAbortController } from './abort.js';
import type { WebScanRefusal } from './worker-authorization.js';
import { WebScanSettingsError } from './worker-settings.js';

/**
 * The reasons the worker itself writes (ADR-0052 section 7).
 *
 * The reasons are fixed. A name of an error never reaches the database, the events or
 * the log: a name is not a stable contract and it can carry anything. The reasons of the
 * package of the scanner are part of the fixed set, and the worker adds the ones only
 * it knows.
 */
export type WebScanWorkerReason =
  | 'request_limit'
  | 'time_limit'
  | 'rate_limited'
  | 'cancelled'
  | 'kill_switch'
  | 'authorization_revoked'
  | 'lease_lost'
  | 'target_error'
  | 'transport_error'
  | 'policy_violation'
  | 'worker_lost'
  | 'site_missing'
  | 'site_removed'
  | 'scope_changed'
  | 'attempt_lost'
  | 'job_lock_lost'
  | 'shutdown'
  | 'settings_unreadable'
  | 'contact_unusable'
  | 'identity_key_missing'
  | 'runner_error';

/**
 * The reason a stopped run ended.
 *
 * The reason of the worker wins over the reason of the package: the worker knows that
 * it aborted, and the package only knows that the scan stopped.
 */
export function stoppedReason(
  abort: WebScanAbortController,
  refusal: WebScanRefusal | null,
  error: ScanStopError,
): WebScanWorkerReason {
  if (abort.reason !== undefined) return abort.reason;
  if (refusal !== null) return refusal;
  return error.reason as WebScanWorkerReason;
}

/**
 * The reason a failed run ended.
 *
 * The reasons are fixed. A runner that throws an error of its own is reported as
 * `runner_error`; the name of the error never reaches the database.
 */
export function failedReason(error: unknown): WebScanWorkerReason {
  if (error instanceof WebScanSettingsError) return error.reason;
  if (error instanceof Error && error.message === 'The web scan site has no identity key') {
    return 'identity_key_missing';
  }
  return 'runner_error';
}

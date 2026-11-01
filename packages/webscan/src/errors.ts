/**
 * The typed control contract of the scanner (ADR-0052 sections 2 and 7).
 *
 * Every guard of the scan — the scope of the package and the transport of the
 * app — reports through the three classes of this module:
 *
 * - {@link ScanStopError} ends the scan. The scan is *stopped*, not failed:
 *   a cancellation, a deadline, an exhausted budget or a lost authorization are
 *   ordinary outcomes, and the pages that were read stay valid.
 * - {@link ScanPolicyError} refuses a request. The scan *fails*: the target
 *   asked for something the administrator did not authorize.
 * - {@link ScanTransportError} reports that the network did not answer. It is
 *   an ordinary, target-scoped outcome and never a policy decision.
 *
 * The classes live in the package because the package owns the contract and
 * the app implements it: the app may not import from `apps/` (ADR-0001), and
 * the package may not import the app's dependencies, so the shared vocabulary
 * has to live on this side of the boundary.
 *
 * Two rules apply to every message of this contract:
 *
 * - A message never carries untrusted text. The URL of a target, the body of a
 *   response and the text of a transport error stay inside the process.
 * - A message never carries a secret. Nothing of this module reaches a log, a
 *   result, a progress event or the dashboard.
 */

import type { ScanStopReason } from './types.js';

/** Why a request was refused before it was sent. */
export type ScanPolicyCode =
  | 'invalid_url'
  | 'malformed_encoding'
  | 'credentials_present'
  | 'unsupported_scheme'
  | 'scheme_not_allowed'
  | 'non_default_port'
  | 'host_not_allowed'
  | 'blocked_path'
  | 'action_denied'
  | 'path_not_allowed'
  | 'parameter_not_allowed'
  | 'query_not_allowed'
  | 'not_relative_path'
  | 'address_not_allowed';

/** Why a transport call failed. */
export type ScanTransportCause =
  | 'timeout'
  | 'reset'
  | 'refused'
  | 'dns'
  | 'tls'
  | 'oversized'
  | 'unknown';

/** The base of every typed control error of the scanner. */
export abstract class ScanControlError extends Error {
  protected constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * A scan-wide stop condition.
 *
 * The scan ends; it does not fail. The reason is one of the bounded stop
 * reasons, so a caller can tell a cancellation from a lost lease without
 * reading a message.
 */
export class ScanStopError extends ScanControlError {
  /** Why the scan stopped. */
  readonly reason: ScanStopReason;

  constructor(reason: ScanStopReason, message: string) {
    super('ScanStopError', message);
    this.reason = reason;
  }
}

/** A request the policy refuses to make at all. */
export class ScanPolicyError extends ScanControlError {
  /** Which rule refused the request. */
  readonly policyCode: ScanPolicyCode;

  constructor(policyCode: ScanPolicyCode, message: string) {
    super('ScanPolicyError', message);
    this.policyCode = policyCode;
  }
}

/** A transport failure. The original error text is deliberately dropped. */
export class ScanTransportError extends ScanControlError {
  /** What kind of failure it was. */
  readonly transportCause: ScanTransportCause;

  constructor(transportCause: ScanTransportCause, message: string) {
    super('ScanTransportError', message);
    this.transportCause = transportCause;
  }
}

/** Whether the error is a typed stop of the scan. */
export function isScanStopError(error: unknown): error is ScanStopError {
  return error instanceof ScanStopError;
}

/** Whether the error is a typed policy refusal. */
export function isScanPolicyError(error: unknown): error is ScanPolicyError {
  return error instanceof ScanPolicyError;
}

/** Whether the error is a typed transport failure. */
export function isScanTransportError(error: unknown): error is ScanTransportError {
  return error instanceof ScanTransportError;
}

/** Whether the error belongs to the typed control contract at all. */
export function isScanControlError(error: unknown): error is ScanControlError {
  return error instanceof ScanControlError;
}

/** Transport error codes, mapped to a cause without exposing their text. */
const TRANSPORT_CODES: Readonly<Record<string, ScanTransportCause>> = {
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  ECONNRESET: 'reset',
  ECONNREFUSED: 'refused',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EHOSTUNREACH: 'dns',
  ENETUNREACH: 'dns',
  CERT_HAS_EXPIRED: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
};

/**
 * Classifies a transport failure from its error code.
 *
 * Only the short code is read. The message of an untrusted error may carry
 * the raw URL, so it is never kept.
 */
export function transportCauseOf(error: unknown): ScanTransportCause {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'unknown';
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') {
    return 'unknown';
  }
  return TRANSPORT_CODES[code] ?? 'unknown';
}

/**
 * The message of a stop reason.
 *
 * The messages are fixed: they never carry the text of a target, a response or
 * a transport error.
 */
const STOP_MESSAGES: Readonly<Record<ScanStopReason, string>> = Object.freeze({
  request_limit: 'The scan reached its request limit.',
  time_limit: 'The scan reached its time limit.',
  rate_limited: 'The site is rate limiting the scan.',
  cancelled: 'The scan was cancelled.',
  kill_switch: 'The scan was stopped by the kill switch.',
  authorization_revoked: 'The scan is no longer authorized.',
  lease_lost: 'The scan lost its lease.',
});

/** The fixed message of a stop reason. */
export function stopMessage(reason: ScanStopReason): string {
  return STOP_MESSAGES[reason];
}

/**
 * The stop reason an aborted signal carries.
 *
 * The worker aborts the scan with a typed reason when it stops it, so a kill
 * switch or a lost lease survives the abort instead of looking like an
 * ordinary cancellation.
 */
export function stopReasonOfSignal(signal: AbortSignal): ScanStopReason {
  const reason: unknown = signal.reason;
  if (reason instanceof ScanStopError) {
    return reason.reason;
  }
  return 'cancelled';
}

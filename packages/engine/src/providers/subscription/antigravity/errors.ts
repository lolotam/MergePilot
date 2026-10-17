/**
 * Google RPC errors from Cloud Code Assist mapped to `LlmFailure` (ADR-0032 §8). The body is read
 * only to classify; every message is a fixed text (with at most the HTTP status, the RPC status
 * enum name and the model id), so no echoed token, link or notice can reach a log or the dashboard.
 */
import { LlmFailure, type LlmFailureCode } from '../../../llm/failure.js';

export const ANTIGRAVITY_PROVIDER = 'google-antigravity';

/** A 429 whose retry delay is longer than this is a quota that will not clear within the review. */
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const CONTEXT_WORDING = /context (length|window)|too many tokens|prompt is too long|maximum context|exceeds the maximum number of tokens/i;
const SUSPENSION_WORDING = /terms of service|has been disabled|suspended|violation/i;
/** google.rpc.Code names such as INVALID_ARGUMENT; anything else in `status` is not trusted into a message. */
const RPC_STATUS = /^[A-Z_]{3,40}$/;

interface GoogleRpcError {
  status?: string;
  message?: string;
  details?: Array<Record<string, unknown>>;
}

function rpcError(bodyText: string): GoogleRpcError {
  try {
    const body: unknown = JSON.parse(bodyText);
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    return error && typeof error === 'object' ? (error as GoogleRpcError) : {};
  } catch {
    return {};
  }
}

/** "12.5s" → 12500. Google's protobuf Duration JSON form. */
function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/** "...reset after 3h20m5s" / "after 45s" in the message, when no RetryInfo was sent. */
function resetAfterMs(message: string): number | undefined {
  const match = /reset(?:s)? after\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(message);
  if (!match?.[1]) return undefined;
  const part = (unit: string) => Number(new RegExp(`(\\d+(?:\\.\\d+)?)${unit}`).exec(match[1]!)?.[1] ?? 0);
  const ms = (part('h') * 3600 + part('m') * 60 + part('s')) * 1000;
  return ms > 0 ? Math.round(ms) : undefined;
}

function detailOfType(error: GoogleRpcError, suffix: string): Record<string, unknown> | undefined {
  return error.details?.find((detail) => typeof detail['@type'] === 'string' && (detail['@type'] as string).endsWith(suffix));
}

function quotaOrRateLimit(error: GoogleRpcError): { code: LlmFailureCode; retryAfterMs?: number } {
  const reason = detailOfType(error, 'google.rpc.ErrorInfo')?.reason;
  const delay = durationMs(detailOfType(error, 'google.rpc.RetryInfo')?.retryDelay) ?? resetAfterMs(error.message ?? '');
  if (reason === 'QUOTA_EXHAUSTED' || (delay !== undefined && delay > RATE_LIMIT_MAX_DELAY_MS)) {
    return { code: 'QUOTA', ...(delay !== undefined ? { retryAfterMs: delay } : {}) };
  }
  return { code: 'RATE_LIMIT', ...(delay !== undefined ? { retryAfterMs: delay } : {}) };
}

function forbidden(bodyText: string): string {
  if (/VALIDATION_REQUIRED/.test(bodyText)) {
    return 'Google asks you to verify this account in the browser; verify it, then sign in again';
  }
  if (SUSPENSION_WORDING.test(bodyText)) return 'Google disabled Antigravity access for this account';
  return 'Google refused access for this account; sign in again';
}

/** Maps one failed Cloud Code Assist response to a failure with a fixed message. */
export function antigravityFailure(status: number, bodyText: string, model: string): LlmFailure {
  const error = rpcError(bodyText);
  const base = { provider: ANTIGRAVITY_PROVIDER, status };
  if (status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    const { code, retryAfterMs } = quotaOrRateLimit(error);
    const text = code === 'QUOTA' ? 'Google Antigravity quota is exhausted for this account' : 'Google Antigravity rate limit reached';
    return new LlmFailure({ ...base, code, message: text, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (status === 401) {
    return new LlmFailure({ ...base, code: 'INVALID_CREDENTIAL', message: 'Google Antigravity sign-in expired or was revoked; sign in again' });
  }
  if (status === 403) return new LlmFailure({ ...base, code: 'INVALID_CREDENTIAL', message: forbidden(bodyText) });
  if (status === 404) {
    return new LlmFailure({ ...base, code: 'BAD_REQUEST', message: `Model ${model} is not available to this Google Antigravity account` });
  }
  if (status === 408 || status === 504) return new LlmFailure({ ...base, code: 'TIMEOUT', message: 'Google Antigravity timed out' });
  if (status >= 500) return new LlmFailure({ ...base, code: 'SERVER', message: `Google Antigravity returned HTTP ${status}` });
  const code: LlmFailureCode = CONTEXT_WORDING.test(bodyText) ? 'CONTEXT_WINDOW_EXCEEDED' : 'BAD_REQUEST';
  // No body text is forwarded on any path: only Google's RPC status, when it is a plain enum name.
  const rpcStatus = typeof error.status === 'string' && RPC_STATUS.test(error.status) ? ` ${error.status}` : '';
  return new LlmFailure({ ...base, code, message: `Google Antigravity rejected the request: HTTP ${status}${rpcStatus} (${code})` });
}

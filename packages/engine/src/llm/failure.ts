export type LlmFailureCode =
  | 'INVALID_CREDENTIAL'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER'
  | 'BAD_REQUEST'
  | 'ABORTED'
  | 'UNKNOWN'
  | 'QUOTA_EXHAUSTED_ALL_KEYS'
  /** The server lacks what a provider needs (Google Antigravity's OAuth client, ADR-0032): an operator fix, not the user's. */
  | 'PROVIDER_NOT_CONFIGURED';

export interface LlmFailureInit {
  code: LlmFailureCode;
  provider: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
  requestId?: string;
}

/** The only error shape that leaves a provider adapter. Never carries request headers or secrets. */
export class LlmFailure extends Error {
  readonly code: LlmFailureCode;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(init: LlmFailureInit) {
    super(init.message);
    this.name = 'LlmFailure';
    this.code = init.code;
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.requestId = init.requestId;
  }
}

export interface HttpFailureInput {
  status: number;
  provider: string;
  headers: Record<string, string | undefined>;
  bodyText: string;
  /** Shorter text for the message (e.g. the provider's own message); defaults to `bodyText`. */
  detail?: string;
}

const QUOTA_WORDING = /quota|billing|insufficient|credit balance|exceeded your|per ?day|daily|payment required|credits? (?:exhausted|remaining: 0)/i;
/** A 400 that is really an empty balance (Anthropic: "Your credit balance is too low ..."). */
const NO_CREDIT_400_WORDING = /credit balance (?:is )?too low|insufficient[_ ]quota/i;
const CONTEXT_WORDING = /context (length|window)|too many tokens|prompt is too long|maximum context/i;
const MAX_BODY_IN_MESSAGE = 300;

function header(headers: HttpFailureInput['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function parseRetryAfter(value: string | undefined, now: () => number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

/** 429 is a short rate limit unless the body names a limit that will not clear soon. */
function code429(bodyText: string): LlmFailureCode {
  // Google names the quota it hit: "...PerDay..." will not clear today, "...PerMinute..." will.
  const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(bodyText)?.[1] ?? '';
  if (/PerDay/i.test(quotaId)) return 'QUOTA';
  if (/PerMinute|PerSecond/i.test(quotaId)) return 'RATE_LIMIT';
  return QUOTA_WORDING.test(bodyText) ? 'QUOTA' : 'RATE_LIMIT';
}

function codeFor(status: number, bodyText: string): LlmFailureCode {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL';
  if (status === 402) return 'QUOTA';
  if (status === 429) return code429(bodyText);
  if (status === 400 && NO_CREDIT_400_WORDING.test(bodyText)) return 'QUOTA';
  if (status === 413 || CONTEXT_WORDING.test(bodyText)) return 'CONTEXT_WINDOW_EXCEEDED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'BAD_REQUEST';
  return 'UNKNOWN';
}

/**
 * Maps a provider HTTP error to a stable `LlmFailure`. Header values are never copied into
 * the message (they can hold keys); only `retry-after` and the request id are read from them.
 */
export function failureFromHttp(input: HttpFailureInput, now: () => number = Date.now): LlmFailure {
  const code = codeFor(input.status, input.bodyText);
  const body = (input.detail ?? input.bodyText).trim().slice(0, MAX_BODY_IN_MESSAGE);
  const retryAfterMs = parseRetryAfter(header(input.headers, 'retry-after'), now);
  const requestId = header(input.headers, 'request-id') ?? header(input.headers, 'x-request-id');

  return new LlmFailure({
    code,
    provider: input.provider,
    status: input.status,
    message: `${input.provider} returned HTTP ${input.status} (${code})${body ? `: ${body}` : ''}`,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

/**
 * The short, user-facing failure categories (ported from the owner's Browser-controle
 * `failure.js`): what the user can act on — top up credit, fix the key, wait, check the network.
 */
export type FailureKind = 'quota' | 'auth' | 'server' | 'network' | 'rate-limit' | 'other';

const KIND_BY_CODE: Readonly<Record<LlmFailureCode, FailureKind>> = {
  QUOTA: 'quota',
  QUOTA_EXHAUSTED_ALL_KEYS: 'quota',
  INVALID_CREDENTIAL: 'auth',
  // The operator's server lacks the sign-in client: nothing the user's credential can fix.
  PROVIDER_NOT_CONFIGURED: 'server',
  RATE_LIMIT: 'rate-limit',
  SERVER: 'server',
  TIMEOUT: 'network',
  NETWORK: 'network',
  CONTEXT_WINDOW_EXCEEDED: 'other',
  BAD_REQUEST: 'other',
  ABORTED: 'other',
  UNKNOWN: 'other',
};

export function failureKind(code: LlmFailureCode): FailureKind {
  return KIND_BY_CODE[code];
}

/**
 * transient: worth a short wait (rate limit, overload, gateway, connection).
 * exhausted: a limit that will not clear soon (quota, credit) — retrying is pointless.
 * fatal: anything else (bad request, key, model, abort).
 */
export type FailureClass = 'transient' | 'exhausted' | 'fatal';

export function classifyFailure(code: LlmFailureCode): FailureClass {
  if (code === 'RATE_LIMIT' || code === 'SERVER' || code === 'TIMEOUT' || code === 'NETWORK') return 'transient';
  if (code === 'QUOTA' || code === 'QUOTA_EXHAUSTED_ALL_KEYS') return 'exhausted';
  return 'fatal';
}

/**
 * The provider's own message from an error body, whose JSON shape differs by provider
 * ({error: {message}}, {detail: {message}}, {error: "..."}), else the raw text, capped.
 */
export function providerMessage(text: string, max = 300): string {
  let message = text;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const inner = record.error ?? record.detail ?? record;
      if (typeof inner === 'string') message = inner;
      else if (inner && typeof inner === 'object') {
        const fields = inner as Record<string, unknown>;
        const found = fields.message ?? fields.msg;
        if (typeof found === 'string') message = found;
      }
    }
  } catch {
    // Not JSON: an HTML error page or plain text, kept as it is.
  }
  return message.trim().slice(0, max);
}

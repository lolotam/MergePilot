export type LlmFailureCode =
  | 'INVALID_CREDENTIAL'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TIMEOUT'
  | 'SERVER'
  | 'BAD_REQUEST'
  | 'ABORTED'
  | 'UNKNOWN';

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
}

const QUOTA_WORDING = /quota|billing|insufficient|credit balance|exceeded your/i;
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

function codeFor(status: number, bodyText: string): LlmFailureCode {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL';
  if (status === 429) return QUOTA_WORDING.test(bodyText) ? 'QUOTA' : 'RATE_LIMIT';
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
  const body = input.bodyText.trim().slice(0, MAX_BODY_IN_MESSAGE);
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

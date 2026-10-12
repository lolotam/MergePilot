/**
 * One Jev request to one provider: `POST {base}/v1/systemone` with a Bearer key. The URL comes
 * only from the fixed provider table. 429 / 529 are retried once after a short backoff; the whole
 * attempt (retry included) has one timeout. Every message that leaves here is key-redacted.
 */
import type { Secret } from '../credentials/secret.js';
import { failureFromHttp, LlmFailure } from '../llm/failure.js';
import { failureFromThrown, keyValue, redactKey, type FetchLike } from '../providers/http.js';
import { systemOneUrl, type JudgeProviderId } from './providers.js';
import {
  JudgeAnswerSchema,
  type JudgeAnswer,
  type JudgeQuestion,
  type JudgeState,
  type JudgeUsage,
} from './types.js';

export const JUDGE_CALL_TIMEOUT_MS = 20_000;
const RETRY_STATUSES = new Set([429, 529]);
const DEFAULT_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5_000;
const MAX_ERROR_TEXT = 4096;

export interface SystemOneCall {
  provider: JudgeProviderId;
  model: string;
  apiKey: Secret | string;
  state: JudgeState;
  questions: Record<string, JudgeQuestion>;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Test seam for the retry backoff. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface SystemOneResult {
  model: string;
  answers: Record<string, JudgeAnswer>;
  usage: JudgeUsage;
  /** USD cost the provider reported (Vercel's gateway does). */
  costUsd?: number | undefined;
}

/** A 2xx reply that does not carry an answer for every question. */
export class JudgeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeResponseError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Usage in snake_case (TypeSafe) or camelCase (Vercel's compatible endpoint). */
export function parseJudgeUsage(value: unknown): JudgeUsage {
  const usage = record(value);
  return {
    inputTokens: num(usage.input_tokens) ?? num(usage.inputTokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? num(usage.outputTokens) ?? 0,
  };
}

/** Parses a 2xx body; every asked question must come back with a well-formed answer. */
export function parseSystemOneResponse(body: unknown, questionIds: readonly string[], requestedModel: string): SystemOneResult {
  const json = record(body);
  const raw = record(json.answers);
  const answers: Record<string, JudgeAnswer> = {};
  for (const id of questionIds) {
    const parsed = JudgeAnswerSchema.safeParse(raw[id]);
    if (!parsed.success) throw new JudgeResponseError(`no valid answer for question "${id}"`);
    answers[id] = parsed.data;
  }
  const cost = num(record(record(json.providerMetadata).gateway).cost);
  return {
    model: typeof json.model === 'string' && json.model ? json.model : requestedModel,
    answers,
    usage: parseJudgeUsage(json.usage),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

/** The provider's message; a 422 names the field (`detail: [{loc, msg}]`). */
export function judgeErrorMessage(text: string): string {
  try {
    const body = record(JSON.parse(text));
    const detail = body.detail ?? body.error;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          const entry = record(item);
          const loc = Array.isArray(entry.loc) ? entry.loc.join('.') : '';
          const msg = typeof entry.msg === 'string' ? entry.msg : typeof entry.message === 'string' ? entry.message : '';
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter(Boolean)
        .join('; ')
        .slice(0, 300);
    }
    if (typeof detail === 'string') return detail.slice(0, 300);
    const inner = record(detail);
    const message = inner.message ?? body.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // Not JSON: the raw text, capped.
  }
  return text.trim().slice(0, 300);
}

async function failureFrom(res: Response, provider: string, key: Secret | string): Promise<LlmFailure> {
  let raw = '';
  try {
    raw = (await res.text()).slice(0, MAX_ERROR_TEXT);
  } catch {
    // An unreadable body still yields the status.
  }
  const headers: Record<string, string | undefined> = {};
  for (const name of ['retry-after', 'request-id', 'x-request-id']) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return failureFromHttp({
    status: res.status,
    provider,
    headers,
    bodyText: redactKey(raw, key),
    detail: redactKey(judgeErrorMessage(raw), key),
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Sends one System One request; throws `LlmFailure` or `JudgeResponseError` on failure. */
export async function callSystemOne(call: SystemOneCall): Promise<SystemOneResult> {
  const { provider, model, apiKey } = call;
  const doFetch: FetchLike = call.fetch ?? ((input, init) => fetch(input, init));
  const timeout = AbortSignal.timeout(call.timeoutMs ?? JUDGE_CALL_TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  const sleep = call.sleep ?? defaultSleep;
  const body = JSON.stringify({ model, state: call.state, questions: call.questions });
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${keyValue(apiKey) ?? ''}`, 'Content-Type': 'application/json' },
    body,
    signal,
    redirect: 'error',
  };

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(systemOneUrl(provider), init);
    } catch (error) {
      throw failureFromThrown(timeout.aborted ? timeout.reason : error, provider, apiKey, call.signal);
    }
    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new JudgeResponseError('the reply is not JSON');
      }
      return parseSystemOneResponse(json, Object.keys(call.questions), model);
    }
    const failure = await failureFrom(res, provider, apiKey);
    if (attempt > 0 || !RETRY_STATUSES.has(res.status)) throw failure;
    await sleep(Math.min(failure.retryAfterMs ?? DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS), signal);
    if (signal.aborted) {
      throw failureFromThrown(timeout.aborted ? timeout.reason : new DOMException('aborted', 'AbortError'), provider, apiKey, call.signal);
    }
  }
}

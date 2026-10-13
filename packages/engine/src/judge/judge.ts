/**
 * The Jev judge: one configured provider plus up to three explicit fallbacks (ADR-0015, following
 * ADR-0008). A request moves to the next entry only on auth, rate limit / overload (after its one
 * retry), 5xx, network, timeout, a 422 / 404 (wrong model id) or a malformed reply; a valid
 * low-confidence answer is a real answer. An entry without a key is skipped. Every attempt is
 * recorded and disclosed; attempts of one request share a 60 s time budget. Once a fallback
 * answered it stays in use for the rest of the review.
 */
import type { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import type { FetchLike } from '../providers/http.js';
import { estimateTokens } from '../review/budget.js';

/** Output tokens assumed per question in the budget preflight (a noul/choice/score answer is far smaller). */
export const JUDGE_OUTPUT_TOKENS_PER_QUESTION = 64;
import { callSystemOne, JUDGE_CALL_TIMEOUT_MS, JudgeResponseError } from './call.js';
import { jevModelPrice, type JudgeProviderId } from './providers.js';
import type { JudgeAttempt, JudgeDecision, JudgeRequest } from './types.js';

function dedupeBefore(failed: readonly JudgeAttempt[]): JudgeAnsweredBy['before'] {
  const seen = new Set<string>();
  const out: JudgeAnsweredBy['before'] = [];
  for (const a of failed) {
    const key = `${a.provider}:${a.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: a.provider, model: a.model, code: a.code ?? 'error', skipped: a.skipped === true });
  }
  return out;
}

export const JUDGE_TOTAL_TIMEOUT_MS = 60_000;
export const MAX_JUDGE_FALLBACKS = 3;

export interface JudgeEntry {
  provider: JudgeProviderId;
  model: string;
  /** Undefined when the workspace / environment has no key: the entry is skipped and disclosed. */
  apiKey?: Secret | undefined;
}

/** A judge model's price in USD per million tokens (Jev bills input; output is usually 0). */
export interface JudgePrice {
  inputPerMTok: number;
  outputPerMTok?: number | undefined;
}

/** Catalog or workspace price for a judge model; undefined falls back to the static Jev table. */
export type JudgePriceLookup = (provider: JudgeProviderId, model: string) => JudgePrice | undefined;

/** One `judge.call` log line: never the state, never a key. */
export interface JudgeCallEvent extends JudgeAttempt {
  questions: number;
  fallbackIndex: number;
}

export interface JudgeOptions {
  /** The configured judge first, then its fallbacks in order. */
  entries: readonly JudgeEntry[];
  fetch?: FetchLike | undefined;
  callTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  onCall?: ((event: JudgeCallEvent) => void) | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  /** Tried before the static `jevModelPrice` table (ADR-0016); a cost the provider reports still wins. */
  priceLookup?: JudgePriceLookup | undefined;
}

export interface JudgeAnsweredBy {
  provider: string;
  model: string;
  fallbackIndex: number;
  /** The entries tried before it in that request, with why they did not answer. */
  before: Array<{ provider: string; model: string; code: string; skipped: boolean }>;
}

/** Everything the judge did during one review, for the summary, the run record and usage. */
export interface JudgeReport {
  attempts: JudgeAttempt[];
  inputTokens: number;
  outputTokens: number;
  /** Sum of the known costs; undefined when no billed attempt had a known price. */
  costUsd?: number | undefined;
  answeredBy?: JudgeAnsweredBy | undefined;
  /** Code of the last request on which every entry failed. */
  unavailable?: string | undefined;
}

export interface Judge {
  readonly label: string;
  readonly entries: ReadonlyArray<{ provider: JudgeProviderId; model: string; hasKey: boolean }>;
  /** Asks every question in one request; throws `JudgeUnavailableError` when every entry failed. */
  decide(request: JudgeRequest): Promise<JudgeDecision>;
  report(): JudgeReport;
}

export class JudgeUnavailableError extends Error {
  readonly code: string;
  readonly attempts: JudgeAttempt[];

  constructor(code: string, attempts: JudgeAttempt[]) {
    super(`Jev judge unavailable: ${code}`);
    this.name = 'JudgeUnavailableError';
    this.code = code;
    this.attempts = attempts;
  }
}

/** Codes after which the next entry is tried; anything else stops the request. */
const MOVE_ON = new Set([
  'auth',
  'rate-limited',
  'quota',
  'overloaded',
  'server',
  'network',
  'timeout',
  'model-not-found',
  'invalid-request',
  'invalid-response',
  'no-key',
  'budget',
]);

/** A short, secret-free code for a failed attempt. */
export function judgeFailureCode(error: unknown): string {
  if (error instanceof JudgeResponseError) return 'invalid-response';
  if (!(error instanceof LlmFailure)) return 'error';
  switch (error.code) {
    case 'INVALID_CREDENTIAL':
      return 'auth';
    case 'RATE_LIMIT':
      return 'rate-limited';
    case 'QUOTA':
      return 'quota';
    case 'SERVER':
      return error.status === 529 ? 'overloaded' : 'server';
    case 'NETWORK':
      return 'network';
    case 'TIMEOUT':
      return 'timeout';
    case 'ABORTED':
      return 'aborted';
    case 'CONTEXT_WINDOW_EXCEEDED':
      return 'too-large';
    case 'BAD_REQUEST':
      if (error.status === 404) return 'model-not-found';
      if (error.status === 422) return 'invalid-request';
      return 'bad-request';
    default:
      return 'error';
  }
}

export function createJudge(options: JudgeOptions): Judge {
  const entries = options.entries.slice(0, 1 + MAX_JUDGE_FALLBACKS);
  if (entries.length === 0) throw new Error('a judge needs at least one provider');
  const now = options.now ?? Date.now;
  const callTimeoutMs = options.callTimeoutMs ?? JUDGE_CALL_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? JUDGE_TOTAL_TIMEOUT_MS;
  const allAttempts: JudgeAttempt[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  let answeredBy: JudgeAnsweredBy | undefined;
  let unavailable: string | undefined;
  // A fallback that answered stays in use for the rest of this review (ADR-0008).
  let startAt = 0;
  const priceOf = (provider: JudgeProviderId, model: string): JudgePrice | undefined => {
    const looked = options.priceLookup?.(provider, model);
    if (looked) return looked;
    const input = jevModelPrice(provider, model);
    return input !== undefined ? { inputPerMTok: input } : undefined;
  };

  const record = (attempt: JudgeAttempt, questions: number, fallbackIndex: number): void => {
    allAttempts.push(attempt);
    options.onCall?.({ ...attempt, questions, fallbackIndex });
  };

  async function decide(request: JudgeRequest): Promise<JudgeDecision> {
    const questions = Object.keys(request.questions).length;
    const deadline = now() + totalTimeoutMs;
    const attempts: JudgeAttempt[] = [];
    const estimate = estimateTokens(JSON.stringify({ state: request.state, questions: request.questions }));
    // Jev answers are short typed values; this generous per-question allowance keeps the
    // preflight conservative when a price has an output rate.
    const outputEstimate = questions * JUDGE_OUTPUT_TOKENS_PER_QUESTION;
    let lastCode = 'no-key';

    for (let index = startAt; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const base = { provider: entry.provider, model: entry.model };
      const skip = (code: string): void => {
        const attempt: JudgeAttempt = { ...base, ok: false, code, ms: 0, skipped: true };
        attempts.push(attempt);
        record(attempt, questions, index);
        lastCode = code;
      };
      const remaining = deadline - now();
      if (remaining <= 0) {
        skip('time-budget');
        break;
      }
      if (!entry.apiKey) {
        skip('no-key');
        continue;
      }
      const price = priceOf(entry.provider, entry.model);
      const worstCaseUsd =
        price === undefined ? undefined : (estimate * price.inputPerMTok + outputEstimate * (price.outputPerMTok ?? 0)) / 1_000_000;
      if (worstCaseUsd !== undefined && request.maxUsd !== undefined && worstCaseUsd > request.maxUsd) {
        skip('budget');
        continue;
      }

      const started = now();
      try {
        const result = await callSystemOne({
          provider: entry.provider,
          model: entry.model,
          apiKey: entry.apiKey,
          state: request.state,
          questions: request.questions,
          fetch: options.fetch,
          timeoutMs: Math.min(callTimeoutMs, remaining),
          signal: request.signal,
          sleep: options.sleep,
        });
        const ms = now() - started;
        const cost =
          result.costUsd ??
          (price !== undefined
            ? (result.usage.inputTokens * price.inputPerMTok + result.usage.outputTokens * (price.outputPerMTok ?? 0)) / 1_000_000
            : undefined);
        const attempt: JudgeAttempt = {
          ...base,
          ok: true,
          ms,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(cost !== undefined ? { costUsd: cost } : {}),
        };
        attempts.push(attempt);
        record(attempt, questions, index);
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
        startAt = index;
        answeredBy = {
          provider: entry.provider,
          model: entry.model,
          fallbackIndex: index,
          // Every earlier entry that failed or was skipped during this review, so a later request
          // that starts at the sticky fallback still discloses why the primary was not used.
          before: dedupeBefore(
            allAttempts.filter((a) => !a.ok && !(a.provider === entry.provider && a.model === entry.model)),
          ),
        };
        return {
          provider: entry.provider,
          model: result.model,
          fallbackIndex: index,
          answers: result.answers,
          usage: result.usage,
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ms,
          attempts,
        };
      } catch (error) {
        const code = judgeFailureCode(error);
        const attempt: JudgeAttempt = { ...base, ok: false, code, ms: now() - started };
        attempts.push(attempt);
        record(attempt, questions, index);
        lastCode = code;
        if (!MOVE_ON.has(code)) break;
      }
    }
    unavailable = lastCode;
    throw new JudgeUnavailableError(lastCode, attempts);
  }

  const primary = entries[0];
  return {
    label: primary ? `${primary.provider}:${primary.model}` : 'jev',
    entries: entries.map((e) => ({ provider: e.provider, model: e.model, hasKey: Boolean(e.apiKey) })),
    decide,
    report: () => ({
      attempts: [...allAttempts],
      inputTokens,
      outputTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(answeredBy ? { answeredBy } : {}),
      ...(unavailable ? { unavailable } : {}),
    }),
  };
}

/** "opencode-zen:jev-1.13-free (fallback 2; openrouter failed: rate-limited)" for the summary. */
export function describeAnsweredBy(answered: JudgeAnsweredBy): string {
  const label = `${answered.provider}:${answered.model}`;
  if (answered.fallbackIndex === 0 && answered.before.length === 0) return label;
  const notes = answered.before.map((b) => `${b.provider} ${b.skipped ? 'skipped' : 'failed'}: ${b.code}`);
  const head = answered.fallbackIndex > 0 ? [`fallback ${answered.fallbackIndex}`] : [];
  return `${label} (${[...head, ...notes].join('; ')})`;
}

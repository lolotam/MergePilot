/**
 * Guards around every model call of a review, so a huge PR never fails as a whole (ADR-0013):
 * - a timeout on each call, combined with the caller's signal;
 * - an overall review deadline after which no new batch starts;
 * - one retry with thinking off after an empty (reasoning-only) reply, budget-gated like
 *   every other extra call (ADR-0011).
 */

import type { Secret } from '../credentials/secret.js';
import { LlmFailure } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { describeCallError, type SpendTracker } from './spend.js';

function timeoutFailure(label: string, timeoutMs: number): LlmFailure {
  return new LlmFailure({
    code: 'TIMEOUT',
    provider: label.split(':')[0] ?? label,
    message: `${label} did not answer within ${Math.round(timeoutMs / 1000)}s (review.callTimeoutMs)`,
  });
}

/**
 * One call with its own timeout. The model gets a signal that aborts on the caller's signal OR
 * the timeout; the call also stops waiting when the timeout fires, even for a backend that
 * ignores the signal. A timeout surfaces as `LlmFailure` code `TIMEOUT`; an abort by the
 * caller keeps the model's own error.
 */
export async function generateWithTimeout(
  model: ReviewModel,
  request: ReviewModelRequest,
  timeoutMs: number,
): Promise<ReviewModelResponse> {
  const outer = request.signal;
  if (outer?.aborted) return model.generate(request);

  const timer = new AbortController();
  const signal = outer ? AbortSignal.any([outer, timer.signal]) : timer.signal;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      timer.abort();
      reject(timeoutFailure(model.label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([model.generate({ ...request, signal }), timedOut]);
  } catch (error) {
    if (timer.signal.aborted && !outer?.aborted) throw timeoutFailure(model.label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(handle);
  }
}

/**
 * The same model with a timeout on every call. Applied to each model of a fallback chain
 * separately, so a timeout is one more failure the ADR-0008 chain decides on (and discloses).
 */
export function withCallTimeout(model: ReviewModel, timeoutMs: number): ReviewModel {
  const outputTokensFor = model.outputTokensFor?.bind(model);
  return {
    get label() {
      return model.label;
    },
    ...(model.fallbacks ? { fallbacks: model.fallbacks } : {}),
    ...(model.secrets ? { secrets: model.secrets } : {}),
    ...(model.skippedFallbacks ? { skippedFallbacks: model.skippedFallbacks } : {}),
    ...(outputTokensFor ? { outputTokensFor } : {}),
    generate: (request) => generateWithTimeout(model, request, timeoutMs),
  };
}

/** The overall review time limit (`review.totalTimeoutMs`), measured from the review start. */
export class ReviewDeadline {
  readonly #endsAt: number;

  constructor(
    totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.#endsAt = now() + totalMs;
  }

  get expired(): boolean {
    return this.now() >= this.#endsAt;
  }
}

/** Shortened, comma-separated paths for an incomplete reason: at most `max`, long paths cut from the left. */
export function describePaths(paths: readonly string[], max = 10, maxLength = 60): string {
  const shorten = (path: string): string =>
    path.length <= maxLength ? path : `…${path.slice(path.length - maxLength + 1)}`;
  const shown = paths.slice(0, max).map(shorten).join(', ');
  return paths.length > max ? `${shown} +${paths.length - max} more` : shown;
}

type ParsedAnswer = { ok: true } | { ok: false; code: string; error: string };

export interface EmptyRetryInput<P extends ParsedAnswer> {
  parsed: P;
  model: ReviewModel;
  spend: SpendTracker;
  /** The request that came back empty; the retry repeats it with `thinking: 'off'`. */
  request: ReviewModelRequest;
  promptTokens: number;
  /** Output tokens the retry is charged at (the configured call's, a safe ceiling). */
  requestedOutputTokens: number;
  parse: (response: ReviewModelResponse) => P;
  knownSecrets?: readonly Secret[] | undefined;
}

export interface EmptyRetryResult<P extends ParsedAnswer> {
  parsed: P;
  /** The retry's response, when one was made: its finish reason drives any truncation retry. */
  response?: ReviewModelResponse | undefined;
  usage?: TokenUsage | undefined;
  /** Disclosure when the retry was skipped or failed; the caller reports it with the error. */
  note?: string | undefined;
  /** True when the answer now comes from a call without thinking, so follow-up calls keep it off. */
  thinkingOff: boolean;
}

/**
 * Retries a call ONCE with thinking off when it returned no visible text (e.g. a GLM model that
 * spent every output token on reasoning). Anything else is returned unchanged.
 */
export async function retryEmptyWithoutThinking<P extends ParsedAnswer>(
  input: EmptyRetryInput<P>,
): Promise<EmptyRetryResult<P>> {
  const { parsed, spend, promptTokens, requestedOutputTokens } = input;
  if (parsed.ok || parsed.code !== 'empty-response') return { parsed, thinkingOff: false };

  if (!spend.canAfford(promptTokens, requestedOutputTokens)) {
    return { parsed, note: 'empty-response retry skipped: budget limit reached', thinkingOff: false };
  }
  try {
    const response = await input.model.generate({ ...input.request, thinking: 'off' });
    spend.record(promptTokens, requestedOutputTokens, response.usage);
    const retried = input.parse(response);
    if (!retried.ok && retried.code === 'empty-response') {
      return {
        parsed: { ...retried, error: `${retried.error} (also with thinking off)` },
        response,
        usage: response.usage,
        thinkingOff: true,
      };
    }
    return { parsed: retried, response, usage: response.usage, thinkingOff: true };
  } catch (err) {
    spend.record(promptTokens, requestedOutputTokens, undefined);
    return {
      parsed,
      note: `empty-response retry failed: ${describeCallError(err, input.knownSecrets)}`,
      thinkingOff: false,
    };
  }
}

/**
 * Per-review USD spend tracking for retries and batches (ADR-0011).
 *
 * Every extra model call (truncation retry, file batch, verification retry, audit chunk retry)
 * is gated by the same rule: spent so far + estimated cost of the next call ≤ perReviewUsd.
 * Some OpenAI-compatible streams report no usage (or all-zero usage); counting those calls as
 * free would let each later call be checked against the whole budget, so a call without real
 * usage is charged at its ESTIMATED cost (prompt estimate + requested output tokens) instead.
 */

import { costUsd, estimateCostUsd } from '../budget/cost.js';
import type { ModelPricing } from '../config/schema.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import type { Secret } from '../credentials/secret.js';
import { estimateTokens } from './budget.js';
import type { ChainMove } from './fallback.js';
import type { ReviewModel } from './model.js';

/** The output-token limit one call really requests (answer + thinking headroom). */
export function requestedOutputTokens(model: ReviewModel, maxOutputTokens: number): number {
  return model.outputTokensFor ? model.outputTokensFor(maxOutputTokens) : maxOutputTokens;
}

/** The answer budget one call really gets for `maxOutputTokens`, within the model's output limit. */
export function answerTokensOf(model: ReviewModel, maxOutputTokens: number, thinking?: 'off'): number {
  return model.answerTokensFor ? model.answerTokensFor(maxOutputTokens, thinking) : maxOutputTokens;
}

/** A truncation retry skipped because the model's output limit leaves no larger answer budget. */
export const OUTPUT_LIMIT_RETRY_SKIPPED = "truncation retry skipped: the model's output limit leaves no room for a larger answer";

/**
 * Whether a truncation retry at `retryOutputTokens` would get more answer room than the first
 * call's `maxOutputTokens`. Not when the model's output limit already clamped the first call: the
 * retry would pay for the whole prompt again for an answer cut at the same point (ADR-0033).
 * `thinking: 'off'` when the truncated answer came from the thinking-off retry: both calls are then
 * sent with thinking off, and sized without thinking headroom.
 */
export function retryAddsAnswerRoom(
  model: ReviewModel,
  maxOutputTokens: number,
  retryOutputTokens: number,
  thinking?: 'off',
): boolean {
  return answerTokensOf(model, retryOutputTokens, thinking) > answerTokensOf(model, maxOutputTokens, thinking);
}

/** True when the backend reported usage that can be priced (a real call never has zero input). */
export function hasRealUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (!usage) return false;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0;
}

export class SpendTracker {
  #spentUsd = 0;

  constructor(
    private readonly pricing: ModelPricing | undefined | (() => ModelPricing | undefined),
    private readonly limitUsd: number,
  ) {}

  private currentPricing(): ModelPricing | undefined {
    return typeof this.pricing === 'function' ? this.pricing() : this.pricing;
  }

  /** USD charged so far: real usage where reported, the estimate otherwise. 0 without pricing. */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** USD still allowed for this review (the whole limit when the review model is unpriced). */
  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.#spentUsd);
  }

  get priced(): boolean {
    return this.currentPricing() !== undefined;
  }

  /** Worst-case cost of one call; 0 without pricing. */
  estimate(promptTokens: number, outputTokens: number): number {
    const pricing = this.currentPricing();
    if (!pricing) return 0;
    return estimateCostUsd({ inputTokens: promptTokens, maxOutputTokens: outputTokens }, pricing);
  }

  /** Whether one more call of this size still fits the per-review budget. Always true without pricing. */
  canAfford(promptTokens: number, outputTokens: number): boolean {
    if (!this.currentPricing()) return true;
    return this.#spentUsd + this.estimate(promptTokens, outputTokens) <= this.limitUsd;
  }

  /**
   * Charges one completed (or failed) call: its real cost when usage was reported, else its
   * estimated cost, so calls on usage-less providers still count against the budget.
   */
  record(promptTokens: number, outputTokens: number, usage: TokenUsage | undefined): void {
    const pricing = this.currentPricing();
    if (!pricing) return;
    this.#spentUsd += hasRealUsage(usage)
      ? costUsd(usage, pricing)
      : this.estimate(promptTokens, outputTokens);
  }
}

/**
 * Whether the chain may move this request from a subscription to the same model on paid API keys
 * (ADR-0027). That switch happens inside one call, after the call's budget check ran at the
 * subscription's $0 price, so the request is priced again at the API price against what is left.
 * Any other move is not this check's business and is allowed.
 */
export function paidSwitchFits(
  spend: SpendTracker,
  apiPricing: ModelPricing | undefined,
  { leaving, next, request }: ChainMove,
): boolean {
  if (!apiPricing || !leaving.includedInSubscription || next.includedInSubscription || next.label !== leaving.label) return true;
  const cost = estimateCostUsd(
    { inputTokens: estimateTokens(request.system + request.user), maxOutputTokens: requestedOutputTokens(next, request.maxOutputTokens) },
    apiPricing,
  );
  return cost <= spend.remainingUsd;
}

/** A short, secret-free description of a failed call: the LlmFailure code, else a redacted message. */
export function describeCallError(err: unknown, knownSecrets: readonly Secret[] = []): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message, [...knownSecrets]).text.slice(0, 200);
}

export interface ReviewCostEstimateInput {
  /** Estimated prompt tokens of each review call: the whole-PR call, or every batch. */
  callPromptTokens: readonly number[];
  reviewOutputTokens: number;
  /** The verification call's worst case (the whole-PR prompt); omitted when verify is off. */
  verifyPromptTokens?: number | undefined;
  verifyOutputTokens: number;
}

/**
 * The up-front USD estimate of a review (ADR-0013 point 7): every review call at its requested
 * output, plus the verification call's worst case. Prompts include their repository context (ADR-0029).
 */
export function estimateReviewCostUsd(input: ReviewCostEstimateInput, pricing: ModelPricing): number {
  const review = input.callPromptTokens.reduce(
    (sum, tokens) => sum + estimateCostUsd({ inputTokens: tokens, maxOutputTokens: input.reviewOutputTokens }, pricing),
    0,
  );
  if (input.verifyPromptTokens === undefined) return review;
  return review + estimateCostUsd({ inputTokens: input.verifyPromptTokens, maxOutputTokens: input.verifyOutputTokens }, pricing);
}

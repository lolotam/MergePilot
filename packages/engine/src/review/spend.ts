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
import type { ReviewModel } from './model.js';

/** The output-token limit one call really requests (answer + thinking headroom). */
export function requestedOutputTokens(model: ReviewModel, maxOutputTokens: number): number {
  return model.outputTokensFor ? model.outputTokensFor(maxOutputTokens) : maxOutputTokens;
}

/** True when the backend reported usage that can be priced (a real call never has zero input). */
export function hasRealUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (!usage) return false;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0;
}

export class SpendTracker {
  #spentUsd = 0;

  constructor(
    private readonly pricing: ModelPricing | undefined,
    private readonly limitUsd: number,
  ) {}

  /** USD charged so far: real usage where reported, the estimate otherwise. 0 without pricing. */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** USD still allowed for this review (the whole limit when the review model is unpriced). */
  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.#spentUsd);
  }

  get priced(): boolean {
    return this.pricing !== undefined;
  }

  /** Worst-case cost of one call; 0 without pricing. */
  estimate(promptTokens: number, outputTokens: number): number {
    if (!this.pricing) return 0;
    return estimateCostUsd({ inputTokens: promptTokens, maxOutputTokens: outputTokens }, this.pricing);
  }

  /** Whether one more call of this size still fits the per-review budget. Always true without pricing. */
  canAfford(promptTokens: number, outputTokens: number): boolean {
    if (!this.pricing) return true;
    return this.#spentUsd + this.estimate(promptTokens, outputTokens) <= this.limitUsd;
  }

  /**
   * Charges one completed (or failed) call: its real cost when usage was reported, else its
   * estimated cost, so calls on usage-less providers still count against the budget.
   */
  record(promptTokens: number, outputTokens: number, usage: TokenUsage | undefined): void {
    if (!this.pricing) return;
    this.#spentUsd += hasRealUsage(usage)
      ? costUsd(usage, this.pricing)
      : this.estimate(promptTokens, outputTokens);
  }
}

/** A short, secret-free description of a failed call: the LlmFailure code, else a redacted message. */
export function describeCallError(err: unknown, knownSecrets: readonly Secret[] = []): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message, [...knownSecrets]).text.slice(0, 200);
}

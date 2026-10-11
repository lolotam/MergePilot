/**
 * Token budget utilities for the review pipeline.
 * Pricing (USD) is out of scope here — only token-count caps are enforced.
 */

/**
 * Rough token estimate: ceil(chars / 3.5).
 * Used for pre-call budget checks where an exact count is unavailable.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export interface CheckBudgetInput {
  promptTokens: number;
  maxInputTokens: number;
}

export type CheckBudgetResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Returns `{ ok: true }` when `promptTokens` fits within `maxInputTokens`,
 * or `{ ok: false, reason }` describing the overage.
 */
export function checkBudget(input: CheckBudgetInput): CheckBudgetResult {
  if (input.promptTokens <= input.maxInputTokens) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `Estimated prompt tokens (${input.promptTokens}) exceed ` +
      `maxInputTokens limit (${input.maxInputTokens}).`,
  };
}

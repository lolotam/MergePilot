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

/** The `skipped-budget` reason when the estimated cost of a review is over `budget.perReviewUsd`. */
export function costOverBudgetReason(estimatedUsd: number, limitUsd: number): string {
  return `estimated $${estimatedUsd.toFixed(2)} > limit $${limitUsd.toFixed(2)}`;
}

/** What a `skipped-budget` reason says, for a plain-words note on the PR. */
export type BudgetSkipReason =
  | { kind: 'input-tokens'; promptTokens: number; maxInputTokens: number }
  | { kind: 'cost'; estimatedUsd: number; limitUsd: number };

const INPUT_TOKENS_REASON = /^Estimated prompt tokens \((\d+)\) exceed maxInputTokens limit \((\d+)\)\.$/;
const COST_REASON = /^estimated \$(\d+(?:\.\d+)?) > limit \$(\d+(?:\.\d+)?)$/;

/**
 * Reads back a reason built by `checkBudget` or `costOverBudgetReason` (they live here together so
 * the formats cannot drift apart); undefined for any other text.
 */
export function parseBudgetSkipReason(reason: string): BudgetSkipReason | undefined {
  const tokens = INPUT_TOKENS_REASON.exec(reason);
  if (tokens) return { kind: 'input-tokens', promptTokens: Number(tokens[1]), maxInputTokens: Number(tokens[2]) };
  const cost = COST_REASON.exec(reason);
  if (cost) return { kind: 'cost', estimatedUsd: Number(cost[1]), limitUsd: Number(cost[2]) };
  return undefined;
}

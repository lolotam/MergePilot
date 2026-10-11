import type { Finding } from '@mergepilot/engine';

export interface ReviewSummaryInput {
  language: 'ar' | 'en';
  /** The model's overall summary; empty when the review was skipped or failed. */
  summary: string;
  /** Findings that could not be anchored to a diff line. */
  summaryOnly: Finding[];
  inlineCount: number;
  complete: boolean;
  incompleteReasons: string[];
  /** e.g. `anthropic:claude-sonnet-5-5`, shown in the footer. */
  modelLabel: string;
  outcome: 'completed' | 'skipped-budget' | 'failed';
  /** Human-readable reason when outcome is not `completed`. */
  reason?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Renders the review body posted above the inline comments (task C4 owns the full design).
 * The hidden idempotency marker is appended separately by `publishReview`.
 */
export function renderReviewSummary(input: ReviewSummaryInput): string {
  return input.summary || input.reason || '';
}

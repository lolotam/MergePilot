import { REVIEW_LIMIT_DEFAULTS, type ReviewLimits } from '../config/schema.js';

/** The ADR-0013 limits, defaulted for a config built in code without the schema. */
export function reviewLimits(review: Partial<ReviewLimits>): ReviewLimits {
  return {
    maxPromptTokens: review.maxPromptTokens ?? REVIEW_LIMIT_DEFAULTS.maxPromptTokens,
    batchTokens: review.batchTokens ?? REVIEW_LIMIT_DEFAULTS.batchTokens,
    callTimeoutMs: review.callTimeoutMs ?? REVIEW_LIMIT_DEFAULTS.callTimeoutMs,
    totalTimeoutMs: review.totalTimeoutMs ?? REVIEW_LIMIT_DEFAULTS.totalTimeoutMs,
  };
}

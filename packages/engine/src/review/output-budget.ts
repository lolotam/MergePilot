/**
 * Output-token budgets that grow with the number of findings a call may return (ADR-0033). The
 * defaults stay as they were up to the default `review.maxFindings` of 5: 4096 tokens for a review
 * answer, 2048 for a verification answer. These are answer budgets: each adapter still adds its
 * thinking headroom on top (`ReviewModel.outputTokensFor`).
 */

/**
 * The model's known output limit left a review call less answer room than `review.maxFindings`
 * findings are sized for (ADR-0033): the calls were clamped to fit, and the summary says so.
 */
export interface OutputLimitDisclosure {
  maxFindings: number;
  /** Answer tokens each review call got within the model's limit. */
  answerTokens: number;
  /** Answer tokens `maxFindings` findings are sized for (`reviewOutputTokensFor`). */
  neededTokens: number;
}

/** Answer budget of one review call at the default findings limit. */
export const BASE_REVIEW_OUTPUT_TOKENS = 4096;
/** Room for the review's summary, beside its findings. */
const REVIEW_SUMMARY_TOKENS = 1024;
/** One finding in the JSON answer: title, body, an optional suggestion and its fields. */
const REVIEW_TOKENS_PER_FINDING = 300;
/** Largest truncation retry of a review call. */
const REVIEW_RETRY_MAX_TOKENS = 32_768;

/** Answer budget of a verification call at five findings or fewer. */
export const BASE_VERIFY_OUTPUT_TOKENS = 2048;
/** One verdict in the verification answer: id, verdict and a short reason. */
const VERIFY_TOKENS_PER_FINDING = 128;
/** Largest verification answer budget, its retry included. */
const VERIFY_MAX_TOKENS = 16_384;

/** Answer budget of one review call asked for at most `maxFindings` findings (16,024 at 50). */
export function reviewOutputTokensFor(maxFindings: number): number {
  return Math.max(BASE_REVIEW_OUTPUT_TOKENS, REVIEW_SUMMARY_TOKENS + maxFindings * REVIEW_TOKENS_PER_FINDING);
}

/** The one retry after a truncated review answer: twice the first budget, at most 32,768. */
export function reviewRetryOutputTokens(maxOutputTokens: number): number {
  return Math.min(maxOutputTokens * 2, REVIEW_RETRY_MAX_TOKENS);
}

/** Answer budget of a verification call over `findings` findings, at most 16,384. */
export function verifyOutputTokensFor(findings: number): number {
  return Math.min(Math.max(BASE_VERIFY_OUTPUT_TOKENS, findings * VERIFY_TOKENS_PER_FINDING), VERIFY_MAX_TOKENS);
}

/** The one retry after a truncated verification answer: twice the first budget, at most 16,384. */
export function verifyRetryOutputTokens(maxOutputTokens: number): number {
  return Math.min(maxOutputTokens * 2, VERIFY_MAX_TOKENS);
}

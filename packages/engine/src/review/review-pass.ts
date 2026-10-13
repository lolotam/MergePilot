/**
 * The model part of a review (pipeline steps d and e): either ONE whole-PR call with its
 * empty-reply and truncation recovery, or, for a PR above `review.maxPromptTokens`, the PR
 * reviewed in capped batches straight away (ADR-0013). Either way the result is one parsed
 * answer plus the incomplete reasons to disclose, or a failure when nothing answered.
 */
import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import { FINDINGS_MISSING_REASON } from './answer.js';
import { executeBatchedReview, parseReviewResponse } from './batch-run.js';
import { retryEmptyWithoutThinking, type ReviewDeadline } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import type { LibraryDoc } from './prompt.js';
import { combineUsage, reviewJsonSchema, type ReviewableFileWithPatch, type RulesFileInput } from './split.js';
import type { SpendTracker } from './spend.js';
import { recoverReviewTruncation } from './truncation.js';
import type { Finding } from './types.js';

export interface ReviewPassContext {
  config: MergePilotConfig;
  model: ReviewModel;
  spend: SpendTracker;
  knownSecrets: readonly Secret[];
  signal?: AbortSignal | undefined;
  deadline: ReviewDeadline;
  /** The whole-PR prompt and its estimated tokens. */
  prompt: { system: string; user: string };
  promptTokens: number;
  maxOutputTokens: number;
  /** Output tokens one review call really requests (thinking headroom included). */
  reviewOutputTokens: number;
  redactedPrTitle: string;
  redactedPrBody: string;
  redactedRulesFiles: RulesFileInput[];
  redactedReviewableFiles: ReviewableFileWithPatch[];
  libraryDocs?: LibraryDoc[] | undefined;
}

export type ReviewPassResult =
  | {
      ok: true;
      summary: string;
      findings: Finding[];
      droppedInvalid: number;
      totalUsage: TokenUsage | undefined;
      incompleteReasons: string[];
    }
  | { ok: false; reason: string; detail?: string | undefined };

/** A thrown model call as a failed pass: the LlmFailure code, the message secret-redacted. */
function failedCall(err: unknown, knownSecrets: readonly Secret[]): ReviewPassResult {
  if (err && typeof err === 'object' && 'code' in err) {
    const message = 'message' in err ? String(err.message ?? '') : '';
    const detail = redactSecrets(message, [...knownSecrets]).text.slice(0, 500);
    return { ok: false, reason: String(err.code), ...(detail ? { detail } : {}) };
  }
  return { ok: false, reason: redactSecrets(String(err), [...knownSecrets]).text.slice(0, 500) };
}

/** One whole-PR call, then the empty-reply retry and the truncation recovery (ADR-0011). */
export async function runSinglePass(ctx: ReviewPassContext): Promise<ReviewPassResult> {
  const { model, spend, signal, prompt, promptTokens, reviewOutputTokens } = ctx;
  const request: ReviewModelRequest = {
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens: ctx.maxOutputTokens,
    responseSchema: reviewJsonSchema(),
    ...(signal ? { signal } : {}),
  };

  let response: ReviewModelResponse;
  try {
    response = await model.generate(request);
    spend.record(promptTokens, reviewOutputTokens, response.usage);
  } catch (err) {
    return failedCall(err, ctx.knownSecrets);
  }

  const empty = await retryEmptyWithoutThinking({
    parsed: parseReviewResponse(response),
    model,
    spend,
    request,
    promptTokens,
    requestedOutputTokens: reviewOutputTokens,
    parse: parseReviewResponse,
    knownSecrets: ctx.knownSecrets,
  });
  const notes = empty.note ? [empty.note] : [];

  const recovery = await recoverReviewTruncation({
    parseResult: empty.parsed,
    modelResponse: empty.response ?? response,
    prompt,
    promptTokens,
    maxOutputTokens: ctx.maxOutputTokens,
    reviewOutputTokens,
    model,
    config: ctx.config,
    spend,
    knownSecrets: ctx.knownSecrets,
    redactedPrTitle: ctx.redactedPrTitle,
    redactedPrBody: ctx.redactedPrBody,
    redactedRulesFiles: ctx.redactedRulesFiles,
    redactedReviewableFiles: ctx.redactedReviewableFiles,
    libraryDocs: ctx.libraryDocs,
    signal,
    totalUsage: combineUsage(response.usage, empty.usage),
    thinkingOff: empty.thinkingOff,
    deadline: ctx.deadline,
  });

  const parsed = recovery.parseResult;
  if (!parsed.ok) {
    // Skipped or failed recovery steps are disclosed alongside the parse error.
    const detail = [...notes, ...recovery.incompleteReasons].join('; ');
    return { ok: false, reason: parsed.error, ...(detail ? { detail } : {}) };
  }
  return {
    ok: true,
    summary: parsed.summary,
    findings: parsed.findings,
    droppedInvalid: parsed.droppedInvalid,
    totalUsage: recovery.totalUsage,
    incompleteReasons: parsed.findingsMissing
      ? [...recovery.incompleteReasons, FINDINGS_MISSING_REASON]
      : recovery.incompleteReasons,
  };
}

/** A PR too big for one call, reviewed in capped batches; it fails only when no batch answered. */
export async function runBatchedPass(
  ctx: ReviewPassContext,
  batches: ReviewableFileWithPatch[][],
): Promise<ReviewPassResult> {
  const result = await executeBatchedReview({
    batches,
    config: ctx.config,
    pr: { title: ctx.redactedPrTitle, body: ctx.redactedPrBody },
    rulesFiles: ctx.redactedRulesFiles,
    model: ctx.model,
    maxOutputTokens: ctx.maxOutputTokens,
    retryOutputTokens: Math.min(ctx.maxOutputTokens * 2, 16384),
    reviewOutputTokens: ctx.reviewOutputTokens,
    spend: ctx.spend,
    knownSecrets: ctx.knownSecrets,
    libraryDocs: ctx.libraryDocs,
    signal: ctx.signal,
    deadline: ctx.deadline,
  });

  if (!result.merged) {
    const detail = result.incompleteReasons.join('; ');
    return {
      ok: false,
      reason: `no batch produced an answer (${batches.length} batches)`,
      ...(detail ? { detail } : {}),
    };
  }
  return {
    ok: true,
    summary: result.merged.summary,
    findings: result.merged.findings,
    droppedInvalid: 0,
    totalUsage: result.totalUsage,
    incompleteReasons: result.incompleteReasons,
  };
}

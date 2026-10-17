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
import { retryUnusableAnswer, type ReviewDeadline } from './call.js';
import type { ManifestFile } from './manifest.js';
import { reviewRetryOutputTokens } from './output-budget.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import type { PromptPr } from './follow-up.js';
import type { ContextFile, LibraryDoc } from './prompt.js';
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
  /** The pull request as every prompt shows it, follow-up included (ADR-0030). */
  promptPr: PromptPr;
  redactedRulesFiles: RulesFileInput[];
  redactedReviewableFiles: ReviewableFileWithPatch[];
  libraryDocs?: LibraryDoc[] | undefined;
  /** The repository context of a batch (ADR-0029), for up-front and recovery batches alike. */
  contextFor?: ((files: ReviewableFileWithPatch[]) => ContextFile[]) | undefined;
  /** Every changed file of the PR, for the manifest of each batch (ADR-0031). */
  manifestFiles?: readonly ManifestFile[] | undefined;
}

export type ReviewPassResult =
  | {
      ok: true;
      summary: string;
      findings: Finding[];
      droppedInvalid: number;
      totalUsage: TokenUsage | undefined;
      incompleteReasons: string[];
      /** Each answer that left the findings list out, when the last one did too; for logs only. */
      answerAttempts?: AnswerAttempt[] | undefined;
    }
  | {
      ok: false;
      reason: string;
      detail?: string | undefined;
      answerAttempts?: AnswerAttempt[] | undefined;
      /** Tokens of the calls that answered before the pass failed; absent when none did. */
      totalUsage?: TokenUsage | undefined;
    };

/** What one answer without the JSON asked for looked like; for the operator's logs only. */
export interface AnswerAttempt {
  chars: number;
  finishReason: string;
  outputTokens?: number;
  /** The first characters of the answer, secret-redacted. */
  preview: string;
  /** The last characters, secret-redacted, when the answer is longer than the preview. */
  tail?: string;
}

const ANSWER_PREVIEW_CHARS = 200;

function answerAttemptOf(response: ReviewModelResponse, knownSecrets: readonly Secret[]): AnswerAttempt {
  const redacted = redactSecrets(response.text, [...knownSecrets]).text;
  return {
    chars: response.text.length,
    finishReason: response.finishReason,
    ...(response.usage ? { outputTokens: response.usage.outputTokens } : {}),
    preview: redacted.slice(0, ANSWER_PREVIEW_CHARS),
    ...(redacted.length > ANSWER_PREVIEW_CHARS ? { tail: redacted.slice(-ANSWER_PREVIEW_CHARS) } : {}),
  };
}

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

  const empty = await retryUnusableAnswer({
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
    promptPr: ctx.promptPr,
    redactedRulesFiles: ctx.redactedRulesFiles,
    redactedReviewableFiles: ctx.redactedReviewableFiles,
    libraryDocs: ctx.libraryDocs,
    contextFor: ctx.contextFor,
    manifestFiles: ctx.manifestFiles,
    signal,
    totalUsage: combineUsage(response.usage, empty.usage),
    thinkingOff: empty.thinkingOff,
    deadline: ctx.deadline,
  });

  const parsed = recovery.parseResult;
  const attempts = (): AnswerAttempt[] =>
    [response, empty.response].filter((r) => r !== undefined).map((r) => answerAttemptOf(r, ctx.knownSecrets));
  if (!parsed.ok) {
    // Skipped or failed recovery steps are disclosed alongside the parse error.
    const detail = [...notes, ...recovery.incompleteReasons].join('; ');
    const answerAttempts = parsed.code === 'invalid-json' ? attempts() : undefined;
    return {
      ok: false,
      reason: parsed.error,
      ...(detail ? { detail } : {}),
      ...(answerAttempts ? { answerAttempts } : {}),
      ...(recovery.totalUsage ? { totalUsage: recovery.totalUsage } : {}),
    };
  }
  return {
    ok: true,
    summary: parsed.summary,
    findings: parsed.findings,
    droppedInvalid: parsed.droppedInvalid,
    totalUsage: recovery.totalUsage,
    incompleteReasons: parsed.findingsMissing
      ? [...notes, ...recovery.incompleteReasons, FINDINGS_MISSING_REASON]
      : [...notes, ...recovery.incompleteReasons],
    ...(parsed.findingsMissing ? { answerAttempts: attempts() } : {}),
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
    pr: ctx.promptPr,
    rulesFiles: ctx.redactedRulesFiles,
    model: ctx.model,
    maxOutputTokens: ctx.maxOutputTokens,
    retryOutputTokens: reviewRetryOutputTokens(ctx.maxOutputTokens),
    reviewOutputTokens: ctx.reviewOutputTokens,
    spend: ctx.spend,
    knownSecrets: ctx.knownSecrets,
    libraryDocs: ctx.libraryDocs,
    contextFor: ctx.contextFor,
    manifestFiles: ctx.manifestFiles,
    signal: ctx.signal,
    deadline: ctx.deadline,
  });

  if (!result.merged) {
    const detail = result.incompleteReasons.join('; ');
    return {
      ok: false,
      reason: `no batch produced an answer (${batches.length} batches)`,
      ...(detail ? { detail } : {}),
      ...(result.totalUsage ? { totalUsage: result.totalUsage } : {}),
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

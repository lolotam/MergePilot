/**
 * Recovery from a truncated whole-PR review answer (ADR-0011): one bigger-output retry, then
 * the PR split into at least two batches. Only for a PR that fit `review.maxPromptTokens`;
 * a bigger PR skips the whole-PR call and is batched up front (ADR-0013).
 */
import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import type { ParseReviewAnswerResult } from './answer.js';
import { executeBatchedReview, parseReviewResponse } from './batch-run.js';
import type { ReviewDeadline } from './call.js';
import type { ManifestFile } from './manifest.js';
import type { PromptPr } from './follow-up.js';
import type { ReviewModel } from './model.js';
import { reviewRetryOutputTokens } from './output-budget.js';
import type { ContextFile, LibraryDoc } from './prompt.js';
import {
  batchFilesBySize,
  combineUsage,
  needsTruncationRetry,
  reviewJsonSchema,
  type ReviewableFileWithPatch,
  type RulesFileInput,
} from './split.js';
import { describeCallError, requestedOutputTokens, type SpendTracker } from './spend.js';

export interface RecoverReviewTruncationInput {
  parseResult: ParseReviewAnswerResult;
  modelResponse: { text: string; finishReason?: string; usage?: TokenUsage };
  prompt: { system: string; user: string };
  promptTokens: number;
  maxOutputTokens: number;
  reviewOutputTokens: number;
  model: ReviewModel;
  config: MergePilotConfig;
  /** Shared per-review spend; the first review call must already be recorded in it. */
  spend: SpendTracker;
  knownSecrets?: readonly Secret[] | undefined;
  /** The pull request as every prompt shows it, follow-up included (ADR-0030). */
  promptPr: PromptPr;
  redactedRulesFiles: RulesFileInput[];
  redactedReviewableFiles: ReviewableFileWithPatch[];
  libraryDocs?: LibraryDoc[] | undefined;
  /** The repository context of each recovery batch (ADR-0029). */
  contextFor?: ((files: ReviewableFileWithPatch[]) => ContextFile[]) | undefined;
  /** Every changed file of the PR, for the manifest of each recovery batch (ADR-0031). */
  manifestFiles?: readonly ManifestFile[] | undefined;
  signal?: AbortSignal | undefined;
  totalUsage?: TokenUsage | undefined;
  /** The answer came from a retry with thinking off: the truncation retry keeps it off. */
  thinkingOff?: boolean | undefined;
  deadline?: ReviewDeadline | undefined;
}

export interface RecoverReviewTruncationResult {
  parseResult: ParseReviewAnswerResult;
  totalUsage?: TokenUsage | undefined;
  incompleteReasons: string[];
}

/**
 * Recovers from a truncated review answer (never from a merely invalid one):
 * 1. Retries once with 2x output allowance if the budget permits.
 * 2. If still truncated, splits the PR files into batches and merges findings.
 * Every skipped or failed step is returned as a disclosed incomplete reason.
 */
export async function recoverReviewTruncation(
  input: RecoverReviewTruncationInput,
): Promise<RecoverReviewTruncationResult> {
  let { parseResult, totalUsage } = input;
  const { modelResponse, prompt, promptTokens, maxOutputTokens, reviewOutputTokens } = input;
  const { model, config, spend, redactedReviewableFiles, libraryDocs, signal } = input;
  const incompleteReasons: string[] = [];

  if (!needsTruncationRetry(parseResult, modelResponse.finishReason)) {
    return { parseResult, totalUsage, incompleteReasons };
  }

  // 1. Retry once with 2x allowance if budget permits
  const retryOutputTokens = reviewRetryOutputTokens(maxOutputTokens);
  const retryRequested = requestedOutputTokens(model, retryOutputTokens);

  if (!spend.canAfford(promptTokens, retryRequested)) {
    incompleteReasons.push('truncation retry skipped: budget limit reached');
  } else {
    try {
      const retryResponse = await model.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: retryOutputTokens,
        responseSchema: reviewJsonSchema(),
        ...(input.thinkingOff ? { thinking: 'off' as const } : {}),
        ...(signal ? { signal } : {}),
      });
      spend.record(promptTokens, retryRequested, retryResponse.usage);
      totalUsage = combineUsage(totalUsage, retryResponse.usage);
      const retryParse = parseReviewResponse(retryResponse);
      if (retryParse.ok) {
        parseResult = retryParse;
      }
    } catch (err) {
      spend.record(promptTokens, retryRequested, undefined);
      incompleteReasons.push(`truncation retry failed: ${describeCallError(err, input.knownSecrets)}`);
    }
  }

  // 2. If still truncated, fall back to splitting the PR into batches
  if (!parseResult.ok && redactedReviewableFiles.length > 1) {
    const batchResult = await executeBatchedReview({
      batches: batchFilesBySize(redactedReviewableFiles),
      config,
      pr: input.promptPr,
      rulesFiles: input.redactedRulesFiles,
      model,
      maxOutputTokens,
      retryOutputTokens,
      reviewOutputTokens,
      spend,
      knownSecrets: input.knownSecrets,
      libraryDocs,
      contextFor: input.contextFor,
      manifestFiles: input.manifestFiles,
      signal,
      initialUsage: totalUsage,
      deadline: input.deadline,
    });

    totalUsage = batchResult.totalUsage;
    incompleteReasons.push(...batchResult.incompleteReasons);
    if (batchResult.merged) {
      parseResult = {
        ok: true,
        summary: batchResult.merged.summary,
        findings: batchResult.merged.findings,
        droppedInvalid: 0,
      };
    }
  }

  return { parseResult, totalUsage, incompleteReasons };
}

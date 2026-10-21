/**
 * Reviews a PR in file batches and merges the answers (ADR-0011, ADR-0013). Each batch is one
 * call, plus at most one retry with thinking off after an empty reply and one truncation
 * retry, all gated by the shared per-review spend. A batch that fails never sinks the others:
 * its failure is disclosed with its file paths, and the review keeps every batch that answered.
 */
import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { FINDINGS_MISSING_REASON, parseReviewAnswer, type ParseReviewAnswerResult } from './answer.js';
import { checkBudget, estimateTokens } from './budget.js';
import { describePaths, remindMissingFindingsList, retryUnusableAnswer, type ReviewDeadline } from './call.js';
import type { PromptPr } from './follow-up.js';
import { renderManifest, type ManifestFile } from './manifest.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { buildReviewPrompt, type ContextFile, type LibraryDoc } from './prompt.js';
import {
  combineUsage,
  dedupeFindings,
  needsTruncationRetry,
  reviewJsonSchema,
  type ReviewableFileWithPatch,
  type RulesFileInput,
} from './split.js';
import {
  describeCallError,
  OUTPUT_LIMIT_RETRY_SKIPPED,
  requestedOutputTokens,
  retryAddsAnswerRoom,
  type SpendTracker,
} from './spend.js';
import type { Finding } from './types.js';
import { mergeWithheld, type WithheldItem } from './withheld.js';

/** Parses one review call's response into findings (finish reason and output tokens included). */
export function parseReviewResponse(response: ReviewModelResponse): ParseReviewAnswerResult {
  return parseReviewAnswer(response.text, {
    finishReason: response.finishReason,
    outputTokens: response.usage?.outputTokens,
  });
}

export interface ExecuteBatchedReviewInput {
  batches: ReviewableFileWithPatch[][];
  config: MergePilotConfig;
  /** Passed through unchanged: a follow-up review's `followUp` must reach every batch (ADR-0030). */
  pr: PromptPr;
  rulesFiles: RulesFileInput[];
  model: ReviewModel;
  maxOutputTokens: number;
  retryOutputTokens: number;
  /** Output tokens one batch call really requests (thinking headroom included). */
  reviewOutputTokens: number;
  /** Shared per-review spend, so the batches together never exceed perReviewUsd. */
  spend: SpendTracker;
  knownSecrets?: readonly Secret[] | undefined;
  libraryDocs?: LibraryDoc[] | undefined;
  /** The repository context of a batch: only its own files' context (ADR-0029). */
  contextFor?: ((files: ReviewableFileWithPatch[]) => ContextFile[]) | undefined;
  /** Every changed file of the PR for the manifest each batch gets (ADR-0031); none without it. */
  manifestFiles?: readonly ManifestFile[] | undefined;
  signal?: AbortSignal | undefined;
  initialUsage?: TokenUsage | undefined;
  /** Overall review time limit: once expired, no new batch starts. */
  deadline?: ReviewDeadline | undefined;
}

export interface ExecuteBatchedReviewResult {
  /** Merged answer, or null when no batch produced one. */
  merged: { summary: string; findings: Finding[]; withheld?: WithheldItem[] | undefined } | null;
  totalUsage?: TokenUsage | undefined;
  incompleteReasons: string[];
}

/** The prompt for batch `index` of `input.batches`, with the PR manifest when there is one. */
export function buildBatchPrompt(
  input: Pick<ExecuteBatchedReviewInput, 'batches' | 'config' | 'pr' | 'rulesFiles' | 'libraryDocs' | 'contextFor' | 'manifestFiles'>,
  index: number,
): { system: string; user: string } {
  const files = input.batches[index] ?? [];
  const contextFiles = input.contextFor?.(files) ?? [];
  const manifest = input.manifestFiles ? renderManifest(input.manifestFiles, input.batches) : undefined;
  return buildReviewPrompt({
    language: input.config.language,
    maxFindings: input.config.review.maxFindings,
    pr: input.pr,
    rulesFiles: input.rulesFiles,
    pathInstructions: input.config.review.pathInstructions,
    files,
    ...(input.libraryDocs ? { libraryDocs: input.libraryDocs } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
    ...(manifest !== undefined ? { batch: { number: index + 1, count: input.batches.length, manifest } } : {}),
  });
}

interface BatchOutcome {
  parsed: ParseReviewAnswerResult;
  usage?: TokenUsage | undefined;
  /** Retries that were skipped or failed, already worded for the incomplete reasons. */
  notes: string[];
}

/** One batch: first call, empty-reply retry with thinking off, truncation retry. Throws only on the first call. */
async function reviewOneBatch(
  input: ExecuteBatchedReviewInput,
  prompt: { system: string; user: string },
  promptTokens: number,
): Promise<BatchOutcome> {
  const { model, spend, signal, reviewOutputTokens, retryOutputTokens } = input;
  const notes: string[] = [];
  const request: ReviewModelRequest = {
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens: input.maxOutputTokens,
    responseSchema: reviewJsonSchema(),
    ...(signal ? { signal } : {}),
  };

  const first = await model.generate(request);
  spend.record(promptTokens, reviewOutputTokens, first.usage);
  let usage = first.usage;

  const empty = await retryUnusableAnswer({
    parsed: parseReviewResponse(first),
    model,
    spend,
    request,
    promptTokens,
    requestedOutputTokens: reviewOutputTokens,
    parse: parseReviewResponse,
    knownSecrets: input.knownSecrets,
  });
  let parsed = empty.parsed;
  usage = combineUsage(usage, empty.usage);
  if (empty.note) notes.push(empty.note);

  if (needsTruncationRetry(parsed, (empty.response ?? first).finishReason)) {
    const retryRequested = requestedOutputTokens(model, retryOutputTokens);
    if (!retryAddsAnswerRoom(model, input.maxOutputTokens, retryOutputTokens, empty.thinkingOff ? 'off' : undefined)) {
      notes.push(OUTPUT_LIMIT_RETRY_SKIPPED);
    } else if (!spend.canAfford(promptTokens, retryRequested)) {
      notes.push('truncation retry skipped: budget limit reached');
    } else {
      try {
        const retryRequest: ReviewModelRequest = {
          ...request,
          maxOutputTokens: retryOutputTokens,
          ...(empty.thinkingOff ? { thinking: 'off' as const } : {}),
        };
        const retry = await model.generate(retryRequest);
        spend.record(promptTokens, retryRequested, retry.usage);
        usage = combineUsage(usage, retry.usage);
        // A summary without the list gets the same one reminder as a first answer (ADR-0011).
        const reminded = await remindMissingFindingsList({
          parsed: parseReviewResponse(retry), model, spend, request: retryRequest, promptTokens,
          requestedOutputTokens: retryRequested, parse: parseReviewResponse, knownSecrets: input.knownSecrets,
        });
        parsed = reminded.parsed;
        usage = combineUsage(usage, reminded.usage);
        if (reminded.note) notes.push(reminded.note);
      } catch (err) {
        spend.record(promptTokens, retryRequested, undefined);
        notes.push(`truncation retry failed: ${describeCallError(err, input.knownSecrets)}`);
      }
    }
  }
  return { parsed, usage, notes };
}

/**
 * Reviews files in batches, merging findings (deduped by path+line+title) and producing one
 * summary. Each call is counted in usage and in the shared spend. Batches that are skipped
 * (budget, time limit) or fail are each listed with their file paths.
 */
export async function executeBatchedReview(
  input: ExecuteBatchedReviewInput,
): Promise<ExecuteBatchedReviewResult> {
  const { batches, spend, reviewOutputTokens } = input;
  let totalUsage = input.initialUsage;
  const batchSummaries: string[] = [];
  const batchFindings: Finding[] = [];
  // What each batch noticed and did not report, merged when the batches answer (ADR-0042).
  const batchWithheld: Array<WithheldItem[] | undefined> = [];
  const incompleteReasons: string[] = [];
  let answered = 0;
  const labelOf = (index: number): string =>
    `batch ${index + 1} (${describePaths((batches[index] ?? []).map((f) => f.path))})`;
  const skipFrom = (index: number, why: string): void => {
    for (let k = index; k < batches.length; k++) incompleteReasons.push(`${labelOf(k)}: ${why}`);
  };

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    if (input.deadline?.expired) {
      incompleteReasons.push(`time limit reached: ${bIdx} of ${batches.length} batches reviewed`);
      skipFrom(bIdx, 'skipped: time limit reached');
      break;
    }
    const label = labelOf(bIdx);
    const batchPrompt = buildBatchPrompt(input, bIdx);
    const bPromptTokens = estimateTokens(batchPrompt.system + batchPrompt.user);

    const tokenBudget = checkBudget({ promptTokens: bPromptTokens, maxInputTokens: input.config.budget.maxInputTokens });
    if (!tokenBudget.ok) {
      incompleteReasons.push(`${label}: ${tokenBudget.reason}`);
      continue;
    }

    if (!spend.canAfford(bPromptTokens, reviewOutputTokens)) {
      skipFrom(bIdx, 'budget limit reached');
      break;
    }

    try {
      const outcome = await reviewOneBatch(input, batchPrompt, bPromptTokens);
      totalUsage = combineUsage(totalUsage, outcome.usage);
      incompleteReasons.push(...outcome.notes.map((note) => `${label}: ${note}`));
      if (outcome.parsed.ok) {
        answered++;
        if (outcome.parsed.summary.trim().length > 0) batchSummaries.push(outcome.parsed.summary.trim());
        batchFindings.push(...outcome.parsed.findings);
        batchWithheld.push(outcome.parsed.withheld);
        if (outcome.parsed.findingsMissing && !outcome.parsed.acceptedAsEmpty) incompleteReasons.push(`${label}: ${FINDINGS_MISSING_REASON}`);
      } else {
        incompleteReasons.push(`${label}: ${outcome.parsed.error}`);
      }
    } catch (err) {
      // A failed call may still have been billed; charge its estimate so the cap stays hard.
      spend.record(bPromptTokens, reviewOutputTokens, undefined);
      incompleteReasons.push(`${label}: ${describeCallError(err, input.knownSecrets)}`);
    }
  }

  const withheld = mergeWithheld(batchWithheld);
  const merged =
    answered === 0
      ? null
      : {
          summary: batchSummaries.join('\n\n') || 'Review completed across file batches.',
          findings: dedupeFindings(batchFindings),
          ...(withheld.length > 0 ? { withheld } : {}),
        };
  return { merged, totalUsage, incompleteReasons };
}

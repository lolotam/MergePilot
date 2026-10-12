import { z } from 'zod';
import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { estimateTokens } from './budget.js';
import { parseReviewAnswer, ReviewAnswerSchema } from './answer.js';
import type { ReviewModel } from './model.js';
import { buildReviewPrompt, type LibraryDoc } from './prompt.js';
import { describeCallError, requestedOutputTokens, type SpendTracker } from './spend.js';
import type { Finding } from './types.js';

export interface ReviewableFileWithPatch {
  path: string;
  patch: string;
}

export interface RulesFileInput {
  path: string;
  content: string;
}

/** Combines token usage from multiple model calls into a single TokenUsage. */
export function combineUsage(u1?: TokenUsage, u2?: TokenUsage): TokenUsage | undefined {
  if (!u1 && !u2) return undefined;
  if (!u1) return u2;
  if (!u2) return u1;
  return {
    inputTokens: u1.inputTokens + u2.inputTokens,
    outputTokens: u1.outputTokens + u2.outputTokens,
    cacheReadTokens: (u1.cacheReadTokens ?? 0) + (u2.cacheReadTokens ?? 0),
    cacheWriteTokens: (u1.cacheWriteTokens ?? 0) + (u2.cacheWriteTokens ?? 0),
  };
}

/**
 * Splits reviewable files into batches by diff size so each batch stays within
 * model context and answer token limits.
 * Guarantees that if files.length >= 2, at least 2 batches are returned.
 */
export function batchFilesBySize(
  files: readonly ReviewableFileWithPatch[],
  maxBatchTokens?: number,
): ReviewableFileWithPatch[][] {
  if (files.length <= 1) return [files.map((f) => ({ ...f }))];

  const fileTokens = files.map((f) => ({ file: f, tokens: estimateTokens(f.patch) }));
  const totalTokens = fileTokens.reduce((sum, item) => sum + item.tokens, 0);
  const targetBatchTokens = maxBatchTokens ?? Math.max(100, Math.floor(totalTokens / 2));

  const batches: ReviewableFileWithPatch[][] = [];
  let currentBatch: ReviewableFileWithPatch[] = [];
  let currentTokens = 0;

  for (const item of fileTokens) {
    if (currentBatch.length > 0 && currentTokens + item.tokens > targetBatchTokens) {
      batches.push(currentBatch);
      currentBatch = [{ ...item.file }];
      currentTokens = item.tokens;
    } else {
      currentBatch.push({ ...item.file });
      currentTokens += item.tokens;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Ensure at least 2 batches if files.length >= 2
  if (batches.length === 1 && files.length >= 2) {
    const mid = Math.ceil(files.length / 2);
    return [
      files.slice(0, mid).map((f) => ({ ...f })),
      files.slice(mid).map((f) => ({ ...f })),
    ];
  }

  return batches;
}

/**
 * Deduplicates findings across batches by path, line, and normalized title.
 * Re-numbers finding IDs sequentially (f1, f2, ...).
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  let idCounter = 1;

  for (const f of findings) {
    const key = `${f.path}:${f.line}:${f.title.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        ...f,
        id: `f${idCounter++}`,
      });
    }
  }

  return result;
}

export interface ExecuteBatchedReviewInput {
  batches: ReviewableFileWithPatch[][];
  config: MergePilotConfig;
  pr: { title: string; body: string };
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
  signal?: AbortSignal | undefined;
  initialUsage?: TokenUsage | undefined;
}

export interface ExecuteBatchedReviewResult {
  /** Merged answer, or null when no batch produced one. */
  merged: { summary: string; findings: Finding[] } | null;
  totalUsage?: TokenUsage | undefined;
  incompleteReasons: string[];
}

const reviewJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>;

/** A parse failure worth a bigger-output retry: the answer was cut off, not merely wrong. */
export function needsTruncationRetry(
  parsed: { ok: true } | { ok: false; code: string },
  finishReason: string | undefined,
): boolean {
  return !parsed.ok && (parsed.code === 'truncated' || finishReason === 'max-tokens');
}

/**
 * Reviews files in batches by size, merging findings (deduped by path+line+title)
 * and producing one summary. Each call is counted in usage and in the shared spend.
 */
export async function executeBatchedReview(
  input: ExecuteBatchedReviewInput,
): Promise<ExecuteBatchedReviewResult> {
  const { batches, config, pr, rulesFiles, model, maxOutputTokens, retryOutputTokens } = input;
  const { reviewOutputTokens, spend, libraryDocs, signal } = input;
  const reviewCfg = config.review;
  let totalUsage = input.initialUsage;
  const batchSummaries: string[] = [];
  const batchFindings: Finding[] = [];
  const incompleteReasons: string[] = [];
  const retryRequested = requestedOutputTokens(model, retryOutputTokens);

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const label = `batch ${bIdx + 1}`;
    const batchPrompt = buildReviewPrompt({
      language: config.language,
      maxFindings: reviewCfg.maxFindings,
      pr,
      rulesFiles,
      pathInstructions: reviewCfg.pathInstructions,
      files: batches[bIdx]!,
      ...(libraryDocs ? { libraryDocs } : {}),
    });
    const bPromptTokens = estimateTokens(batchPrompt.system + batchPrompt.user);

    if (!spend.canAfford(bPromptTokens, reviewOutputTokens)) {
      incompleteReasons.push(`${label}: budget limit reached`);
      break;
    }

    try {
      const bRes = await model.generate({
        system: batchPrompt.system,
        user: batchPrompt.user,
        maxOutputTokens,
        responseSchema: reviewJsonSchema(),
        ...(signal ? { signal } : {}),
      });
      spend.record(bPromptTokens, reviewOutputTokens, bRes.usage);
      totalUsage = combineUsage(totalUsage, bRes.usage);

      let bParsed = parseReviewAnswer(bRes.text, {
        finishReason: bRes.finishReason,
        outputTokens: bRes.usage?.outputTokens,
      });

      if (needsTruncationRetry(bParsed, bRes.finishReason)) {
        if (!spend.canAfford(bPromptTokens, retryRequested)) {
          incompleteReasons.push(`${label}: truncation retry skipped: budget limit reached`);
        } else {
          try {
            const bRetryRes = await model.generate({
              system: batchPrompt.system,
              user: batchPrompt.user,
              maxOutputTokens: retryOutputTokens,
              responseSchema: reviewJsonSchema(),
              ...(signal ? { signal } : {}),
            });
            spend.record(bPromptTokens, retryRequested, bRetryRes.usage);
            totalUsage = combineUsage(totalUsage, bRetryRes.usage);
            bParsed = parseReviewAnswer(bRetryRes.text, {
              finishReason: bRetryRes.finishReason,
              outputTokens: bRetryRes.usage?.outputTokens,
            });
          } catch (err) {
            spend.record(bPromptTokens, retryRequested, undefined);
            incompleteReasons.push(
              `${label}: truncation retry failed: ${describeCallError(err, input.knownSecrets)}`,
            );
          }
        }
      }

      if (bParsed.ok) {
        if (bParsed.summary.trim().length > 0) batchSummaries.push(bParsed.summary.trim());
        batchFindings.push(...bParsed.findings);
      } else {
        incompleteReasons.push(`${label}: ${bParsed.error}`);
      }
    } catch (err) {
      // A failed call may still have been billed; charge its estimate so the cap stays hard.
      spend.record(bPromptTokens, reviewOutputTokens, undefined);
      incompleteReasons.push(`${label}: ${describeCallError(err, input.knownSecrets)}`);
    }
  }

  const merged =
    batchSummaries.length === 0 && batchFindings.length === 0
      ? null
      : {
          summary: batchSummaries.join('\n\n') || 'Review completed across file batches.',
          findings: dedupeFindings(batchFindings),
        };
  return { merged, totalUsage, incompleteReasons };
}

export interface RecoverReviewTruncationInput {
  parseResult: ReturnType<typeof parseReviewAnswer>;
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
  redactedPrTitle: string;
  redactedPrBody: string;
  redactedRulesFiles: RulesFileInput[];
  redactedReviewableFiles: ReviewableFileWithPatch[];
  libraryDocs?: LibraryDoc[] | undefined;
  signal?: AbortSignal | undefined;
  totalUsage?: TokenUsage | undefined;
}

export interface RecoverReviewTruncationResult {
  parseResult: ReturnType<typeof parseReviewAnswer>;
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
  const retryOutputTokens = Math.min(maxOutputTokens * 2, 16384);
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
        ...(signal ? { signal } : {}),
      });
      spend.record(promptTokens, retryRequested, retryResponse.usage);
      totalUsage = combineUsage(totalUsage, retryResponse.usage);
      const retryParse = parseReviewAnswer(retryResponse.text, {
        finishReason: retryResponse.finishReason,
        outputTokens: retryResponse.usage?.outputTokens,
      });
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
      pr: { title: input.redactedPrTitle, body: input.redactedPrBody },
      rulesFiles: input.redactedRulesFiles,
      model,
      maxOutputTokens,
      retryOutputTokens,
      reviewOutputTokens,
      spend,
      knownSecrets: input.knownSecrets,
      libraryDocs,
      signal,
      initialUsage: totalUsage,
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

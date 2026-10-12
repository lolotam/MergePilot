import { z } from 'zod';
import type { MergePilotConfig } from '../config/schema.js';
import type { TokenUsage } from '../llm/types.js';
import { costUsd, estimateCostUsd } from '../budget/cost.js';
import { estimateTokens } from './budget.js';
import { parseReviewAnswer, ReviewAnswerSchema } from './answer.js';
import type { ReviewModel } from './model.js';
import { buildReviewPrompt, type LibraryDoc } from './prompt.js';
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
  reviewOutputTokens: number;
  libraryDocs?: LibraryDoc[] | undefined;
  signal?: AbortSignal | undefined;
  initialUsage?: TokenUsage | undefined;
}

export interface ExecuteBatchedReviewResult {
  summary: string;
  findings: Finding[];
  totalUsage?: TokenUsage | undefined;
  incompleteReasons: string[];
}

/**
 * Reviews files in batches by size, merging findings (deduped by path+line+title)
 * and producing one summary. Each call is counted in usage/cost.
 */
export async function executeBatchedReview(
  input: ExecuteBatchedReviewInput,
): Promise<ExecuteBatchedReviewResult | null> {
  const {
    batches,
    config,
    pr,
    rulesFiles,
    model,
    maxOutputTokens,
    retryOutputTokens,
    reviewOutputTokens,
    libraryDocs,
    signal,
  } = input;

  const budgetCfg = config.budget;
  const reviewCfg = config.review;
  let totalUsage = input.initialUsage;
  const batchSummaries: string[] = [];
  const batchFindings: Finding[] = [];
  const incompleteReasons: string[] = [];

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batchFiles = batches[bIdx]!;
    const batchPrompt = buildReviewPrompt({
      language: config.language,
      maxFindings: reviewCfg.maxFindings,
      pr,
      rulesFiles,
      pathInstructions: reviewCfg.pathInstructions,
      files: batchFiles,
      ...(libraryDocs ? { libraryDocs } : {}),
    });

    const bPromptTokens = estimateTokens(batchPrompt.system + batchPrompt.user);
    if (budgetCfg.pricing) {
      const currentSpent = totalUsage ? costUsd(totalUsage, budgetCfg.pricing) : 0;
      const bCost = estimateCostUsd(
        { inputTokens: bPromptTokens, maxOutputTokens: reviewOutputTokens },
        budgetCfg.pricing,
      );
      if (currentSpent + bCost > budgetCfg.perReviewUsd) {
        incompleteReasons.push(`batch ${bIdx + 1}: budget limit reached`);
        break;
      }
    }

    try {
      const bRes = await model.generate({
        system: batchPrompt.system,
        user: batchPrompt.user,
        maxOutputTokens,
        responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
        ...(signal ? { signal } : {}),
      });
      totalUsage = combineUsage(totalUsage, bRes.usage);

      let bParsed = parseReviewAnswer(bRes.text, {
        finishReason: bRes.finishReason,
        outputTokens: bRes.usage?.outputTokens,
      });

      if (!bParsed.ok && (bParsed.code === 'truncated' || bRes.finishReason === 'max-tokens')) {
        const canRetry = !budgetCfg.pricing || (() => {
          const currentSpent = totalUsage ? costUsd(totalUsage, budgetCfg.pricing) : 0;
          const retryRequested = model.outputTokensFor ? model.outputTokensFor(retryOutputTokens) : retryOutputTokens;
          const bRetryCost = estimateCostUsd(
            { inputTokens: bPromptTokens, maxOutputTokens: retryRequested },
            budgetCfg.pricing,
          );
          return currentSpent + bRetryCost <= budgetCfg.perReviewUsd;
        })();

        if (canRetry) {
          const bRetryRes = await model.generate({
            system: batchPrompt.system,
            user: batchPrompt.user,
            maxOutputTokens: retryOutputTokens,
            responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
            ...(signal ? { signal } : {}),
          });
          totalUsage = combineUsage(totalUsage, bRetryRes.usage);
          bParsed = parseReviewAnswer(bRetryRes.text, {
            finishReason: bRetryRes.finishReason,
            outputTokens: bRetryRes.usage?.outputTokens,
          });
        }
      }

      if (bParsed.ok) {
        if (bParsed.summary && bParsed.summary.trim().length > 0) {
          batchSummaries.push(bParsed.summary.trim());
        }
        batchFindings.push(...bParsed.findings);
      } else {
        incompleteReasons.push(`batch ${bIdx + 1}: ${bParsed.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      incompleteReasons.push(`batch ${bIdx + 1}: ${msg}`);
    }
  }

  if (batchSummaries.length === 0 && batchFindings.length === 0) {
    return null;
  }

  return {
    summary: batchSummaries.join('\n\n') || 'Review completed across file batches.',
    findings: dedupeFindings(batchFindings),
    totalUsage,
    incompleteReasons,
  };
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
 * Recovers from truncated review answer:
 * 1. Retries once with 2x output allowance if budget permits.
 * 2. If still truncated, splits the PR files into batches and merges findings.
 */
export async function recoverReviewTruncation(
  input: RecoverReviewTruncationInput,
): Promise<RecoverReviewTruncationResult> {
  let { parseResult, totalUsage } = input;
  const {
    modelResponse,
    prompt,
    promptTokens,
    maxOutputTokens,
    reviewOutputTokens,
    model,
    config,
    redactedPrTitle,
    redactedPrBody,
    redactedRulesFiles,
    redactedReviewableFiles,
    libraryDocs,
    signal,
  } = input;

  const budgetCfg = config.budget;
  const incompleteReasons: string[] = [];
  const isTruncated =
    !parseResult.ok &&
    (parseResult.code === 'truncated' || modelResponse.finishReason === 'max-tokens');

  if (!isTruncated) {
    return { parseResult, totalUsage, incompleteReasons };
  }

  // 1. Retry once with 2x allowance if budget permits
  const retryOutputTokens = Math.min(maxOutputTokens * 2, 16384);
  const retryRequested = model.outputTokensFor ? model.outputTokensFor(retryOutputTokens) : retryOutputTokens;
  const currentCost = totalUsage && budgetCfg.pricing ? costUsd(totalUsage, budgetCfg.pricing) : 0;
  const retryCost = budgetCfg.pricing
    ? estimateCostUsd({ inputTokens: promptTokens, maxOutputTokens: retryRequested }, budgetCfg.pricing)
    : 0;

  if (!budgetCfg.pricing || currentCost + retryCost <= budgetCfg.perReviewUsd) {
    try {
      const retryResponse = await model.generate({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: retryOutputTokens,
        responseSchema: z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>,
        ...(signal ? { signal } : {}),
      });
      totalUsage = combineUsage(totalUsage, retryResponse.usage);
      const retryParse = parseReviewAnswer(retryResponse.text, {
        finishReason: retryResponse.finishReason,
        outputTokens: retryResponse.usage?.outputTokens,
      });
      if (retryParse.ok) {
        parseResult = retryParse;
      }
    } catch {
      // Retry failed; fall back to splitting PR below
    }
  }

  // 2. If still truncated, fall back to splitting the PR into batches
  if (!parseResult.ok && redactedReviewableFiles.length > 1) {
    const batches = batchFilesBySize(redactedReviewableFiles);
    const batchResult = await executeBatchedReview({
      batches,
      config,
      pr: { title: redactedPrTitle, body: redactedPrBody },
      rulesFiles: redactedRulesFiles,
      model,
      maxOutputTokens,
      retryOutputTokens,
      reviewOutputTokens,
      libraryDocs,
      signal,
      initialUsage: totalUsage,
    });

    if (batchResult) {
      totalUsage = batchResult.totalUsage;
      incompleteReasons.push(...batchResult.incompleteReasons);
      parseResult = {
        ok: true,
        summary: batchResult.summary,
        findings: batchResult.findings,
        droppedInvalid: 0,
      };
    }
  }

  return { parseResult, totalUsage, incompleteReasons };
}

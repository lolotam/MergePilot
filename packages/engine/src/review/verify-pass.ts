/**
 * The verification pass of the review pipeline (PRD v0.2 §7), budget-gated like every other
 * extra call (ADR-0011): the first verify call and its one truncation retry each run only
 * when spent so far + their estimated cost still fit perReviewUsd. Skips and failures are
 * returned as disclosed incomplete reasons, never swallowed. An empty (reasoning-only) reply gets
 * one gated retry with thinking off, and the pass is skipped once the review time limit is
 * reached (ADR-0013).
 */

import { z } from 'zod';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { estimateTokens } from './budget.js';
import { retryUnusableAnswer, type ReviewDeadline } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { combineUsage, needsTruncationRetry, type ReviewableFileWithPatch } from './split.js';
import { describeCallError, requestedOutputTokens, type SpendTracker } from './spend.js';
import type { ContextFile } from './prompt.js';
import type { Finding } from './types.js';
import {
  applyVerdicts,
  buildVerifyPrompt,
  parseVerifyAnswer,
  VerifyAnswerSchema,
  type VerifyRejectedFinding,
} from './verify.js';

export const VERIFY_MAX_OUTPUT_TOKENS = 2048;
const VERIFY_RETRY_OUTPUT_TOKENS = Math.min(VERIFY_MAX_OUTPUT_TOKENS * 2, 8192);

export interface VerifyPassInput {
  language: 'ar' | 'en';
  findings: Finding[];
  files: ReviewableFileWithPatch[];
  contextFiles?: readonly ContextFile[] | undefined;
  /** Estimated tokens of code the verifier is shown in total (ADR-0028: `review.batchTokens`). */
  maxCodeTokens?: number | undefined;
  model: ReviewModel;
  spend: SpendTracker;
  knownSecrets: readonly Secret[];
  totalUsage: TokenUsage | undefined;
  signal?: AbortSignal | undefined;
  deadline?: ReviewDeadline | undefined;
}

export interface VerifyPassResult {
  findings: Finding[];
  totalUsage: TokenUsage | undefined;
  verification?: { checked: number; rejected: number } | undefined;
  /** Every rejected finding, so the summary discloses what verification dropped. */
  rejected: VerifyRejectedFinding[];
  incompleteReasons: string[];
}

export async function runVerifyPass(input: VerifyPassInput): Promise<VerifyPassResult> {
  const { model, spend, signal } = input;
  let totalUsage = input.totalUsage;
  const incompleteReasons: string[] = [];
  const unchanged = (reason: string): VerifyPassResult => ({
    findings: input.findings,
    totalUsage,
    rejected: [],
    incompleteReasons: [...incompleteReasons, `verification skipped: ${reason}`],
  });

  const verifyPrompt = buildVerifyPrompt({
    language: input.language,
    findings: input.findings,
    files: input.files,
    contextFiles: input.contextFiles,
    maxCodeTokens: input.maxCodeTokens,
  });
  const promptTokens = estimateTokens(verifyPrompt.system + verifyPrompt.user);
  const firstRequested = requestedOutputTokens(model, VERIFY_MAX_OUTPUT_TOKENS);
  const responseSchema = z.toJSONSchema(VerifyAnswerSchema) as Record<string, unknown>;

  if (input.deadline?.expired) {
    return unchanged('time limit reached');
  }
  if (!spend.canAfford(promptTokens, firstRequested)) {
    return unchanged('budget limit reached');
  }

  const parse = (res: ReviewModelResponse): ReturnType<typeof parseVerifyAnswer> =>
    parseVerifyAnswer(res.text, { finishReason: res.finishReason, outputTokens: res.usage?.outputTokens });
  const request: ReviewModelRequest = {
    system: verifyPrompt.system,
    user: verifyPrompt.user,
    maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
    responseSchema,
    ...(signal ? { signal } : {}),
  };

  let verifyParsed: ReturnType<typeof parseVerifyAnswer>;
  try {
    const res = await model.generate(request);
    spend.record(promptTokens, firstRequested, res.usage);
    totalUsage = combineUsage(totalUsage, res.usage);

    const empty = await retryUnusableAnswer({
      parsed: parse(res),
      model,
      spend,
      request,
      promptTokens,
      requestedOutputTokens: firstRequested,
      parse,
      knownSecrets: input.knownSecrets,
    });
    verifyParsed = empty.parsed;
    totalUsage = combineUsage(totalUsage, empty.usage);
    if (empty.note) incompleteReasons.push(`verification ${empty.note}`);

    if (needsTruncationRetry(verifyParsed, (empty.response ?? res).finishReason)) {
      const retryRequested = requestedOutputTokens(model, VERIFY_RETRY_OUTPUT_TOKENS);
      if (!spend.canAfford(promptTokens, retryRequested)) {
        incompleteReasons.push('verification retry skipped: budget limit reached');
      } else {
        try {
          const retryRes = await model.generate({
            ...request,
            maxOutputTokens: VERIFY_RETRY_OUTPUT_TOKENS,
            ...(empty.thinkingOff ? { thinking: 'off' as const } : {}),
          });
          spend.record(promptTokens, retryRequested, retryRes.usage);
          totalUsage = combineUsage(totalUsage, retryRes.usage);
          verifyParsed = parse(retryRes);
        } catch (err) {
          spend.record(promptTokens, retryRequested, undefined);
          incompleteReasons.push(
            `verification retry failed: ${describeCallError(err, input.knownSecrets)}`,
          );
        }
      }
    }
  } catch (err) {
    spend.record(promptTokens, firstRequested, undefined);
    return unchanged(describeCallError(err, input.knownSecrets));
  }

  if (!verifyParsed.ok) {
    return unchanged(verifyParsed.error);
  }

  const { kept, rejected } = applyVerdicts(input.findings, verifyParsed.verdicts);
  return {
    findings: kept,
    totalUsage,
    verification: { checked: input.findings.length, rejected: rejected.length },
    rejected: rejected.map(({ finding }) => ({ title: finding.title, path: finding.path, line: finding.line })),
    incompleteReasons,
  };
}

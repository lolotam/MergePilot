/**
 * The verification pass of the review pipeline (PRD v0.2 §7), budget-gated like every other
 * extra call (ADR-0011): the first verify call and its one truncation retry each run only
 * when spent so far + their estimated cost still fit perReviewUsd. Skips and failures are
 * returned as disclosed incomplete reasons, never swallowed. An empty (reasoning-only) reply gets
 * one gated retry with thinking off, and the pass is skipped once the review time limit is
 * reached (ADR-0013). The prompt is fitted to `budget.maxInputTokens` before the call, less the
 * room the JSON-only retry needs: the owner's rules give up the overflow, then are left out, and
 * a prompt that still does not fit is skipped with a disclosed reason (ADR-0044).
 */

import { z } from 'zod';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { checkBudget, estimateTokens } from './budget.js';
import { JSON_ONLY_REMINDER, retryUnusableAnswer, type ReviewDeadline } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { combineUsage, needsTruncationRetry, type ReviewableFileWithPatch } from './split.js';
import { verifyOutputTokensFor, verifyRetryOutputTokens } from './output-budget.js';
import {
  describeCallError,
  OUTPUT_LIMIT_RETRY_SKIPPED,
  requestedOutputTokens,
  retryAddsAnswerRoom,
  type SpendTracker,
} from './spend.js';
import type { ContextFile, PathInstruction } from './prompt.js';
import type { Finding } from './types.js';
import { VERIFY_CRITERIA_TOKENS } from './verify-criteria.js';
import {
  applyVerdicts,
  buildVerifyPrompt,
  parseVerifyAnswer,
  VerifyAnswerSchema,
  type BuiltVerifyPrompt,
  type VerifyRejectedFinding,
} from './verify.js';

export interface VerifyPassInput {
  language: 'ar' | 'en';
  findings: Finding[];
  files: ReviewableFileWithPatch[];
  contextFiles?: readonly ContextFile[] | undefined;
  /** Estimated tokens of code the verifier is shown in total (ADR-0028: `review.batchTokens`). */
  maxCodeTokens?: number | undefined;
  /**
   * The owner's rules files, already redacted, shown when a finding carries a ruleRef (ADR-0044).
   */
  rulesFiles?: readonly { path: string; content: string }[] | undefined;
  /**
   * Path instructions; those whose glob matches a changed file are shown with the rules files.
   */
  pathInstructions?: readonly PathInstruction[] | undefined;
  /**
   * The `budget.maxInputTokens` limit: the verification prompt must fit it (less the room the
   * JSON-only retry needs), the owner's rules shortened or left out first (ADR-0044).
   */
  maxInputTokens?: number | undefined;
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

/**
 * The verification prompt that fits `limit`: the owner's rules give up the overflow first, then
 * are left out, and the step taken is disclosed (ADR-0044). The prompt returned may still be over
 * the limit; the caller skips the call then, with the reason the review call uses.
 */
function buildFittingVerifyPrompt(
  input: VerifyPassInput,
  limit: number | undefined,
): {
  prompt: BuiltVerifyPrompt;
  promptTokens: number;
  note?: string;
} {
  const base = {
    language: input.language,
    findings: input.findings,
    files: input.files,
    contextFiles: input.contextFiles,
    maxCodeTokens: input.maxCodeTokens,
    rulesFiles: input.rulesFiles,
    pathInstructions: input.pathInstructions,
  };
  const prompt = buildVerifyPrompt(base);
  const promptTokens = estimateTokens(prompt.system + prompt.user);
  if (limit === undefined || promptTokens <= limit) return { prompt, promptTokens };

  // The verification without the owner's rules: the last step before the call is skipped.
  const withoutRules = buildVerifyPrompt({ ...base, rulesFiles: undefined, pathInstructions: undefined });
  // No rule block was shown (the system prompt names the rules only then): the code alone is over
  // the limit, so there is nothing to shorten and nothing to disclose here.
  if (prompt.system === withoutRules.system) return { prompt, promptTokens };
  const withoutRulesTokens = estimateTokens(withoutRules.system + withoutRules.user);
  const hasRules = (input.rulesFiles?.length ?? 0) > 0 || (input.pathInstructions?.length ?? 0) > 0;
  if (hasRules) {
    const shortened = shortenRules(base, promptTokens, prompt.criteriaTokens, limit);
    // The system prompt names the rules only when a rule block is shown, so the two prompts
    // differ exactly when the shortened one still shows a rule.
    if (shortened && shortened.system !== withoutRules.system) {
      return {
        prompt: shortened,
        promptTokens: estimateTokens(shortened.system + shortened.user),
        note: 'verification rules shortened to fit maxInputTokens',
      };
    }
  }
  // The note says the rules were left out to fit the limit: it is only true when the prompt
  // without them fits. When it does not, the call is skipped, and its reason stands alone.
  if (withoutRulesTokens <= limit) {
    return {
      prompt: withoutRules,
      promptTokens: withoutRulesTokens,
      note: 'verification shown without the owner rules to fit maxInputTokens',
    };
  }
  return { prompt: withoutRules, promptTokens: withoutRulesTokens };
}

/** How many times the rules cap is lowered by the overflow before the rules are left out. */
const SHORTEN_ATTEMPTS = 5;
/** The least each step lowers the cap: a cut drops whole lines, so a smaller step may drop none. */
const SHORTEN_MIN_STEP = 50;

/**
 * The verification prompt with the rules cap lowered by the overflow until the prompt fits, or
 * undefined. The cap starts at the size the shown REVIEW_CRITERIA blocks really take, so a small
 * rules block is cut instead of left out. The rule lines the system prompt gains with a shown
 * block are outside the cap, so one step can leave a small overflow: the cap is lowered again by
 * what is left over.
 */
function shortenRules(
  base: Parameters<typeof buildVerifyPrompt>[0],
  promptTokens: number,
  criteriaTokens: number,
  limit: number,
): BuiltVerifyPrompt | undefined {
  let cap = Math.min(VERIFY_CRITERIA_TOKENS, criteriaTokens);
  let tokens = promptTokens;
  for (let attempt = 0; attempt < SHORTEN_ATTEMPTS; attempt++) {
    cap -= Math.max(tokens - limit, SHORTEN_MIN_STEP);
    if (cap <= 0) return undefined;
    const shortened = buildVerifyPrompt({ ...base, maxCriteriaTokens: cap });
    tokens = estimateTokens(shortened.system + shortened.user);
    if (tokens <= limit) return shortened;
  }
  return undefined;
}

export async function runVerifyPass(input: VerifyPassInput): Promise<VerifyPassResult> {
  const { model, spend, signal } = input;
  let totalUsage = input.totalUsage;
  const incompleteReasons: string[] = [];
  // The JSON-only retry sends the same request with a reminder appended and does not check the
  // limit itself, so the room for that reminder is reserved here.
  const inputLimit =
    input.maxInputTokens === undefined
      ? undefined
      : input.maxInputTokens - estimateTokens(JSON_ONLY_REMINDER);
  // The prompt is fitted to the input-token limit before anything else, and the step taken is
  // disclosed in every outcome (ADR-0044).
  const fitted = buildFittingVerifyPrompt(input, inputLimit);
  if (fitted.note) incompleteReasons.push(fitted.note);
  const unchanged = (reason: string): VerifyPassResult => ({
    findings: input.findings,
    totalUsage,
    rejected: [],
    incompleteReasons: [...incompleteReasons, `verification skipped: ${reason}`],
  });

  const verifyPrompt = fitted.prompt;
  const promptTokens = fitted.promptTokens;
  // The answer has one verdict per finding, so its budget grows with them (ADR-0033).
  const maxOutputTokens = verifyOutputTokensFor(input.findings.length);
  const retryOutputTokens = verifyRetryOutputTokens(maxOutputTokens);
  const firstRequested = requestedOutputTokens(model, maxOutputTokens);
  const responseSchema = z.toJSONSchema(VerifyAnswerSchema) as Record<string, unknown>;

  if (input.deadline?.expired) {
    return unchanged('time limit reached');
  }
  if (input.maxInputTokens !== undefined) {
    // The JSON-only retry adds the reminder, so it is counted here against the configured limit.
    const retryTokens = promptTokens + estimateTokens(JSON_ONLY_REMINDER);
    const tokenBudget = checkBudget({ promptTokens: retryTokens, maxInputTokens: input.maxInputTokens });
    if (!tokenBudget.ok) return unchanged(tokenBudget.reason);
  }
  if (!spend.canAfford(promptTokens, firstRequested)) {
    return unchanged('budget limit reached');
  }

  const parse = (res: ReviewModelResponse): ReturnType<typeof parseVerifyAnswer> =>
    parseVerifyAnswer(res.text, { finishReason: res.finishReason, outputTokens: res.usage?.outputTokens });
  const request: ReviewModelRequest = {
    system: verifyPrompt.system,
    user: verifyPrompt.user,
    maxOutputTokens,
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
      const retryRequested = requestedOutputTokens(model, retryOutputTokens);
      if (!retryAddsAnswerRoom(model, maxOutputTokens, retryOutputTokens, empty.thinkingOff ? 'off' : undefined)) {
        incompleteReasons.push(`verification ${OUTPUT_LIMIT_RETRY_SKIPPED}`);
      } else if (!spend.canAfford(promptTokens, retryRequested)) {
        incompleteReasons.push('verification retry skipped: budget limit reached');
      } else {
        try {
          const retryRes = await model.generate({
            ...request,
            maxOutputTokens: retryOutputTokens,
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

/**
 * The review pipeline: classify → redact → build prompt → budget check → model call →
 * parse answer → select + anchor findings → return result. A PR above
 * `review.maxPromptTokens` skips the whole-PR call and is reviewed in capped batches;
 * every call has its own timeout and the review an overall time limit (ADR-0013).
 *
 * Pure engine code: no GitHub calls, no filesystem access, no network.
 * Everything arrives through `RunReviewInput` (ADR-0001).
 */

import { REVIEW_LIMIT_DEFAULTS, type MergePilotConfig, type ReviewLimits } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import { classifyFile } from '../diff/classify-file.js';
import { parsePatch, type ParsedPatch } from '../diff/parse-patch.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { anchorFindings } from '../validate/anchor.js';
import { selectFindings } from '../validate/select.js';
import { buildBatchPrompt } from './batch-run.js';
import { checkBudget, estimateTokens } from './budget.js';
import { ReviewDeadline, withCallTimeout } from './call.js';
import { estimateCostUsd } from '../budget/cost.js';
import { runFalsePositiveFilter, type FalsePositiveOutcome } from '../judge/false-positive.js';
import { hasJudgeUse, type JudgeUses } from '../judge/uses.js';
import type { Judge } from '../judge/judge.js';
import { FallbackChain, type FallbackDisclosure } from './fallback.js';
import { secretsToRedact, type ReviewModel } from './model.js';
import { buildReviewPrompt, type LibraryDoc } from './prompt.js';
import type { Finding, ReviewResult, Severity } from './types.js';
import {
  makeRedactionFinding,
  buildPatchLineToNewLineMap,
} from './patch-helpers.js';
import { runBatchedPass, runSinglePass, type AnswerAttempt, type ReviewPassContext } from './review-pass.js';
import { batchFilesByTokenCap, type CappedBatches } from './split.js';
import { SpendTracker } from './spend.js';
import { runVerifyPass, VERIFY_MAX_OUTPUT_TOKENS } from './verify-pass.js';

// ── Input types ──

export interface PrFile {
  path: string;
  status: string;
  patch?: string | undefined;
  changes: number;
}

export interface RulesFile {
  path: string;
  content: string;
}

export interface RunReviewInput {
  config: MergePilotConfig;
  pr: { title: string; body: string };
  files: PrFile[];
  /** Optional full PR files to anchor inline findings to PR patch lines (used during incremental review). */
  anchorFiles?: PrFile[] | undefined;
  rulesFiles: RulesFile[];
  model: ReviewModel;
  /** Explicit fallback models (ADR-0008); defaults to `model.fallbacks`, else none. */
  fallbackModels?: readonly ReviewModel[] | undefined;
  knownSecrets: Secret[];
  libraryDocs?: LibraryDoc[] | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Optional Jev judge (ADR-0015); its false-positive check runs after the verify pass when `uses`
   * has `annotate` or `filter` (one request covers both).
   */
  judge?: { judge: Judge; uses: JudgeUses; threshold: number } | undefined;
}

/** What the Jev false-positive filter did (the kept findings are the result's findings). */
export type JudgeFilterSummary = Omit<FalsePositiveOutcome, 'findings'>;

// ── Output types ──

export type ReviewRunResult =
  | ({
      status: 'completed';
      summary: string;
      inline: Finding[];
      summaryOnly: Finding[];
      result: ReviewResult;
      usage?: TokenUsage | undefined;
      costUsd?: number | undefined;
      droppedInvalid: number;
      complete: boolean;
      verification?: { checked: number; rejected: number } | undefined;
      judge?: JudgeFilterSummary | undefined;
    } & Partial<FallbackDisclosure>)
  | { status: 'skipped-budget'; reason: string }
  | ({
      status: 'failed';
      reason: string;
      /** Provider message, already secret-redacted by the adapter; for logs and the summary. */
      detail?: string | undefined;
      /** Each answer that had no usable JSON (secret-redacted preview); for logs only, never the summary. */
      answerAttempts?: AnswerAttempt[] | undefined;
    } & Partial<FallbackDisclosure>);

// ── Pipeline ──

/**
 * Runs the full single-pass review pipeline described in PRD v0.2 §7 steps 2–8.
 */
export async function runReview(input: RunReviewInput): Promise<ReviewRunResult> {
  const { config, pr, files, rulesFiles, signal } = input;
  const reviewCfg = config.review;
  const budgetCfg = config.budget;
  const limits = reviewLimits(reviewCfg);
  const deadline = new ReviewDeadline(limits.totalTimeoutMs);
  // One chain per review, so a fallback lasts for the rest of this review only (ADR-0008).
  // Each model gets its own per-call timeout, so a timeout is a failure the chain decides on.
  const fallbackModels = input.fallbackModels ?? input.model.fallbacks ?? [];
  const model = new FallbackChain(
    withCallTimeout(input.model, limits.callTimeoutMs),
    fallbackModels.map((m) => withCallTimeout(m, limits.callTimeoutMs)),
  );
  const subscriptionPricing = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
  const currentPricing = () => model.includedInSubscription ? subscriptionPricing : budgetCfg.pricing;
  // Every key a model in the chain may send is redacted before ANY model call, fallbacks included.
  const knownSecrets = secretsToRedact(input.knownSecrets, input.model, fallbackModels);

  // ── Step a: classify files ─────────────────────────────────────────────
  const incompleteReasons: string[] = [];
  const reviewableFiles: Array<{ path: string; patch: string }> = [];

  for (const file of files) {
    const classification = classifyFile(file, {
      exclude: reviewCfg.exclude,
      isSensitivePath,
    });

    if (classification === 'incomplete-truncated') {
      incompleteReasons.push(`${file.path}: patch truncated`);
    } else if (classification === 'review' && file.patch) {
      reviewableFiles.push({ path: file.path, patch: file.patch });
    }
  }

  // ── Step b: redact secrets ─────────────────────────────────────────────
  const securityFindings: Finding[] = [];
  let secFindingIdx = 1;

  // Redact PR text
  const redactedPrTitle = redactSecrets(pr.title, knownSecrets).text;
  const redactedPrBody = redactSecrets(pr.body, knownSecrets).text;

  // Redact rules files
  const redactedRulesFiles = rulesFiles.map((rf) => ({
    path: rf.path,
    content: redactSecrets(rf.content, knownSecrets).text,
  }));

  // Redact patches and collect security findings for added lines
  const redactedReviewableFiles: Array<{ path: string; patch: string }> = [];

  for (const rf of reviewableFiles) {
    const redactResult = redactSecrets(rf.patch, knownSecrets);
    redactedReviewableFiles.push({ path: rf.path, patch: redactResult.text });

    // Build a map from patch-text line# → new-side file line# so we can correlate
    // redactSecrets findings (patch-text line numbers) with actual file line numbers.
    const patchLineToNewLine = buildPatchLineToNewLineMap(rf.patch);
    // Parse original patch to know which new-side lines are "added"
    const parsed = parsePatch(rf.patch);

    for (const finding of redactResult.found) {
      const newSideLine = patchLineToNewLine.get(finding.line);
      // Only emit a finding if the redacted line is an added line on the new side
      if (newSideLine !== undefined && parsed.addedLines.has(newSideLine)) {
        securityFindings.push(
          makeRedactionFinding(rf.path, newSideLine, finding.kind, secFindingIdx++),
        );
      }
    }
  }

  // ── Step c: build prompt + budget check ───────────────────────────────
  const prompt = buildReviewPrompt({
    language: config.language,
    maxFindings: reviewCfg.maxFindings,
    pr: { title: redactedPrTitle, body: redactedPrBody },
    rulesFiles: redactedRulesFiles,
    pathInstructions: reviewCfg.pathInstructions,
    files: redactedReviewableFiles,
    ...(input.libraryDocs ? { libraryDocs: input.libraryDocs } : {}),
  });

  const promptTokens = estimateTokens(prompt.system + prompt.user);
  const budgetResult = checkBudget({
    promptTokens,
    maxInputTokens: budgetCfg.maxInputTokens,
  });

  if (!budgetResult.ok) {
    return { status: 'skipped-budget', reason: budgetResult.reason };
  }

  // Size guard (ADR-0013): a prompt too big for one reliable call goes straight to capped batches.
  let plan: CappedBatches | undefined;
  if (promptTokens > limits.maxPromptTokens && redactedReviewableFiles.length > 0) {
    plan = batchFilesByTokenCap(redactedReviewableFiles, limits.batchTokens);
    for (const path of plan.truncatedPaths) {
      incompleteReasons.push(`${path}: patch truncated to fit review.batchTokens`);
    }
  }
  const promptArgs = {
    config,
    pr: { title: redactedPrTitle, body: redactedPrBody },
    rulesFiles: redactedRulesFiles,
    libraryDocs: input.libraryDocs,
  };
  const callPromptTokens = plan
    ? plan.batches.map((batch) => {
        const batchPrompt = buildBatchPrompt(promptArgs, batch);
        return estimateTokens(batchPrompt.system + batchPrompt.user);
      })
    : [promptTokens];

  const maxOutputTokens = 4096;
  // Price the output limit each call really requests: answer budget + effort's thinking headroom
  // (largest across the chain). Thinking is billed as output, so pricing less could overspend.
  const reviewOutputTokens = model.outputTokensFor(maxOutputTokens);
  const verifyOutputTokens = model.outputTokensFor(VERIFY_MAX_OUTPUT_TOKENS);
  let estimatedCostUsd: number | undefined;
  const initialPricing = currentPricing();
  if (initialPricing) {
    const pricing = initialPricing;
    estimatedCostUsd = callPromptTokens.reduce(
      (sum, tokens) => sum + estimateCostUsd({ inputTokens: tokens, maxOutputTokens: reviewOutputTokens }, pricing),
      0,
    );
    if (reviewCfg.verify) {
      // Worst case for the verification call: its hunks are a subset of the review prompt.
      estimatedCostUsd += estimateCostUsd(
        { inputTokens: promptTokens, maxOutputTokens: verifyOutputTokens },
        pricing,
      );
    }
    if (estimatedCostUsd > budgetCfg.perReviewUsd) {
      return {
        status: 'skipped-budget',
        reason: `estimated $${estimatedCostUsd.toFixed(2)} > limit $${budgetCfg.perReviewUsd.toFixed(2)}`,
      };
    }
  }

  // Real spend across every call of this review; usage-less calls count at their estimate.
  const spend = new SpendTracker(currentPricing, budgetCfg.perReviewUsd);

  // ── Steps d + e: model call(s), parse, recovery ────────────────────────
  const passContext: ReviewPassContext = {
    config,
    model,
    spend,
    knownSecrets,
    signal,
    deadline,
    prompt,
    promptTokens,
    maxOutputTokens,
    reviewOutputTokens,
    redactedPrTitle,
    redactedPrBody,
    redactedRulesFiles,
    redactedReviewableFiles,
    libraryDocs: input.libraryDocs,
  };
  const pass = plan ? await runBatchedPass(passContext, plan.batches) : await runSinglePass(passContext);
  if (!pass.ok) {
    return {
      status: 'failed',
      reason: pass.reason,
      ...(pass.detail ? { detail: pass.detail } : {}),
      ...(pass.answerAttempts ? { answerAttempts: pass.answerAttempts } : {}),
      ...model.disclosure(knownSecrets),
    };
  }
  let totalUsage = pass.totalUsage;
  incompleteReasons.push(...pass.incompleteReasons);

  // ── Step e2: verification pass ─────────────────────────────────────────
  let modelFindings = pass.findings;
  let verification: { checked: number; rejected: number } | undefined;

  if (reviewCfg.verify && modelFindings.length > 0) {
    const verified = await runVerifyPass({
      language: config.language,
      findings: modelFindings,
      files: redactedReviewableFiles,
      model,
      spend,
      knownSecrets,
      totalUsage,
      signal,
      deadline,
    });
    modelFindings = verified.findings;
    totalUsage = verified.totalUsage;
    verification = verified.verification;
    incompleteReasons.push(...verified.incompleteReasons);
  }

  // ── Step e3: Jev false-positive filter (ADR-0015) ──────────────────────
  // A failed judge leaves the findings unchanged; the outcome carries its code for disclosure.
  let judge: JudgeFilterSummary | undefined;
  const judgeChecks =
    input.judge !== undefined && (hasJudgeUse(input.judge.uses, 'annotate') || hasJudgeUse(input.judge.uses, 'filter'));
  if (input.judge && judgeChecks && modelFindings.length > 0) {
    const { findings: judged, ...summary } = await runFalsePositiveFilter({
      ...input.judge,
      findings: modelFindings,
      files: redactedReviewableFiles,
      knownSecrets,
      language: config.language,
      signal,
      maxUsd: spend.remainingUsd,
    });
    modelFindings = judged;
    judge = summary;
  }

  // ── Step f: select + anchor ────────────────────────────────────────────
  const allFindings = [...securityFindings, ...modelFindings];

  const selected = selectFindings(allFindings, {
    maxFindings: reviewCfg.maxFindings,
    minSeverity: reviewCfg.minSeverity as Severity,
  });

  // Build patch index for anchoring. An incremental review passes the full PR diff as
  // `anchorFiles`: inline comments must land on lines of the PR's own patch, and only on its
  // RIGHT side (the reviewed patch's LEFT lines belong to the previous head, not the PR base).
  const anchorSource = input.anchorFiles ?? redactedReviewableFiles;
  const patchIndex = new Map<string, ParsedPatch>();
  for (const f of anchorSource) {
    if (!f.patch) continue;
    const parsed = parsePatch(f.patch);
    patchIndex.set(f.path, input.anchorFiles ? { ...parsed, leftLines: new Set<number>() } : parsed);
  }

  const { inline, summaryOnly } = anchorFindings(selected, patchIndex);

  // ── Step g: assemble result ────────────────────────────────────────────
  const complete = incompleteReasons.length === 0;

  const result: ReviewResult = {
    summary: pass.summary,
    findings: selected,
    complete,
    incompleteReasons,
  };

  // Pricing belongs to the configured model; after a fallback the cost is unknown (tokens still count).
  const disclosure = model.disclosure(knownSecrets);
  let reviewCostUsd: number | undefined;
  if (model.onlySubscriptionCalls) {
    reviewCostUsd = 0;
  } else if (budgetCfg.pricing && !disclosure.fallbackFrom) {
    // Real cost where usage was reported, the estimate for calls without usage (ADR-0011).
    reviewCostUsd = spend.spentUsd;
  }

  return {
    status: 'completed',
    summary: pass.summary,
    inline,
    summaryOnly,
    result,
    usage: totalUsage,
    ...(reviewCostUsd !== undefined ? { costUsd: reviewCostUsd } : {}),
    droppedInvalid: pass.droppedInvalid,
    complete,
    ...(verification !== undefined ? { verification } : {}),
    ...(judge ? { judge } : {}),
    ...disclosure,
  };
}

/** The ADR-0013 limits, defaulted for a config built in code without the schema. */
function reviewLimits(review: Partial<ReviewLimits>): ReviewLimits {
  return {
    maxPromptTokens: review.maxPromptTokens ?? REVIEW_LIMIT_DEFAULTS.maxPromptTokens,
    batchTokens: review.batchTokens ?? REVIEW_LIMIT_DEFAULTS.batchTokens,
    callTimeoutMs: review.callTimeoutMs ?? REVIEW_LIMIT_DEFAULTS.callTimeoutMs,
    totalTimeoutMs: review.totalTimeoutMs ?? REVIEW_LIMIT_DEFAULTS.totalTimeoutMs,
  };
}

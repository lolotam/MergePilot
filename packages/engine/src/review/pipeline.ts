/**
 * The review pipeline: classify → redact → build prompt → budget check → model call →
 * parse answer → select + anchor findings → return result. A PR above
 * `review.maxPromptTokens` skips the whole-PR call and is reviewed in capped batches;
 * every call has its own timeout and the review an overall time limit (ADR-0013).
 *
 * Pure engine code: no GitHub calls, no filesystem access, no network.
 * Everything arrives through `RunReviewInput` (ADR-0001).
 */

import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_PR_CONTEXT_TOKENS,
  REVIEW_LIMIT_DEFAULTS,
  type MergePilotConfig,
  type ModelPricing,
  type ReviewLimits,
} from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { TokenUsage } from '../llm/types.js';
import { redactSecrets } from '../security/redact.js';
import { anchorFindings } from '../validate/anchor.js';
import { selectFindings } from '../validate/select.js';
import { buildBatchPrompt } from './batch-run.js';
import { classifyChangedFiles } from './changed-files.js';
import { checkBudget, costOverBudgetReason, estimateTokens } from './budget.js';
import { ReviewDeadline, withCallTimeout } from './call.js';
import { ContextPlan, type ContextDisclosure, type RepositoryContextFile } from './context.js';
import { exploreBeforeSinglePass, type ExploreInput, type ExplorationDisclosure } from './explore-step.js';
import { runFalsePositiveFilter, type FalsePositiveOutcome } from '../judge/false-positive.js';
import { hasJudgeUse, type JudgeUses } from '../judge/uses.js';
import type { Judge } from '../judge/judge.js';
import { FallbackChain, type FallbackDisclosure } from './fallback.js';
import { prepareFollowUp, promptPrOf, type FollowUp } from './follow-up.js';
import { secretsToRedact, type ReviewModel } from './model.js';
import { renderNotShown } from './manifest.js';
import { reviewOutputTokensFor, verifyOutputTokensFor, type OutputLimitDisclosure } from './output-budget.js';
import { buildReviewPrompt, type LibraryDoc } from './prompt.js';
import type { Finding, ReviewResult, Severity } from './types.js';
import { redactWithheld, type WithheldItem } from './withheld.js';
import { anchorIndexOf, redactPatches } from './patch-helpers.js';
import { runBatchedPass, runSinglePass, type AnswerAttempt, type ReviewPassContext } from './review-pass.js';
import { batchFilesByTokenCap, combineUsage, type CappedBatches } from './split.js';
import { estimateReviewCostUsd, paidSwitchFits, SpendTracker } from './spend.js';
import type { ReviewSkill } from './skill.js';
import { runVerifyPass } from './verify-pass.js';
import type { RejectedFinding, VerifyRejectedFinding } from './verify.js';

/** Room for context fences and token-estimate rounding at the whole-PR prompt boundary. */
const WHOLE_CONTEXT_SAFETY_TOKENS = 128;

// ── Input types ──

export interface PrFile {
  path: string;
  status: string;
  patch?: string | undefined;
  changes: number;
  /** GitHub's line counts, for the PR manifest of a batched review; counted from the patch when absent. */
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface RulesFile {
  path: string;
  content: string;
}

export interface RunReviewInput {
  config: MergePilotConfig;
  pr: { title: string; body: string };
  files: PrFile[];
  /**
   * The full PR files on an incremental review: inline findings anchor to their PR patch lines, in
   * the files of `files` only (ADR-0012, ADR-0030).
   */
  anchorFiles?: PrFile[] | undefined;
  /**
   * Set on an incremental review (ADR-0030): the prompts say it is a follow-up of `sinceSha`, show
   * the PR's other changed files offered as `pr-change` context, and list the bot's open findings.
   * Without it a review is a whole-PR review, as before, and `pr-change` context is ignored.
   */
  followUp?: FollowUp | undefined;
  rulesFiles: RulesFile[];
  /**
   * The bot's review skill (ADR-0034): the last section of every review call's system prompt,
   * redacted with `knownSecrets`. It never reaches the verify pass or the Jev judge.
   */
  skill?: ReviewSkill | undefined;
  model: ReviewModel;
  /** Explicit fallback models (ADR-0008); defaults to `model.fallbacks`, else none. */
  fallbackModels?: readonly ReviewModel[] | undefined;
  knownSecrets: Secret[];
  libraryDocs?: LibraryDoc[] | undefined;
  /**
   * Repository files outside the diff, read at the PR head (ADR-0029). The pipeline filters,
   * redacts and fits them to each call's `review.contextTokens` share; untrusted like the patches.
   */
  contextFiles?: RepositoryContextFile[] | undefined;
  /**
   * Read-only repository exploration (ADR-0046): the reader the exploration rounds use, at the PR
   * head. Without it the exploration stays off, whatever `review.explore` says.
   */
  explore?: ExploreInput | undefined;
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
      /** Problems the model noticed and did not report, secret-redacted (ADR-0042); summary only. */
      withheld?: WithheldItem[] | undefined;
      result: ReviewResult;
      usage?: TokenUsage | undefined;
      costUsd?: number | undefined;
      droppedInvalid: number;
      complete: boolean;
      verification?: { checked: number; rejected: number } | undefined;
      /** Findings the verification pass rejected, listed in the summary (ADR-0028). */
      verifyRejected?: VerifyRejectedFinding[] | undefined;
      /** Transient panel input; never persisted in ReviewResult. */
      verifyRejectedFindings?: RejectedFinding[] | undefined;
      judge?: JudgeFilterSummary | undefined;
      /** Repository context sent and left out (ADR-0029); a disclosure, not an incomplete reason. */
      context?: ContextDisclosure | undefined;
      /** What the read-only exploration did (ADR-0046); a disclosure, not an incomplete reason. */
      exploration?: ExplorationDisclosure | undefined;
      /** The model's output limit clamped the answer budget below what maxFindings needs (ADR-0033). */
      outputLimit?: OutputLimitDisclosure | undefined;
      /** Each answer that left the findings list out (secret-redacted preview); for logs only, never the summary. */
      answerAttempts?: AnswerAttempt[] | undefined;
      /** Every attempted call, failures included, was on a subscription: the run cost $0. */
      onlySubscriptionCalls: boolean;
    } & Partial<FallbackDisclosure>)
  | { status: 'skipped-budget'; reason: string }
  | ({
      status: 'failed';
      reason: string;
      /** Provider message, already secret-redacted by the adapter; for logs and the summary. */
      detail?: string | undefined;
      /** Each answer that had no usable JSON (secret-redacted preview); for logs only, never the summary. */
      answerAttempts?: AnswerAttempt[] | undefined;
      /** Tokens of the calls that answered before the failure. */
      usage?: TokenUsage | undefined;
      /** What those calls cost, by the same rule as a completed run; absent when unknown. */
      costUsd?: number | undefined;
      /** What the read-only exploration did (ADR-0046); a disclosure, not an incomplete reason. */
      exploration?: ExplorationDisclosure | undefined;
      onlySubscriptionCalls: boolean;
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
  const model: FallbackChain = new FallbackChain(
    withCallTimeout(input.model, limits.callTimeoutMs),
    fallbackModels.map((m) => withCallTimeout(m, limits.callTimeoutMs)),
    (move) => paidSwitchFits(spend, budgetCfg.pricing, move),
  );
  const subscriptionPricing = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
  const currentPricing = () => model.includedInSubscription ? subscriptionPricing : budgetCfg.pricing;
  // Every key a model in the chain may send is redacted before ANY model call, fallbacks included.
  const knownSecrets = secretsToRedact(input.knownSecrets, input.model, fallbackModels);
  const followUp = prepareFollowUp(input.followUp, knownSecrets);

  // ── Step a: classify files ─────────────────────────────────────────────
  const { reviewableFiles, incompleteReasons, manifestFiles } = classifyChangedFiles(files, {
    exclude: reviewCfg.exclude,
    knownSecrets,
  });

  // ── Step b: redact secrets ─────────────────────────────────────────────
  // Redact PR text
  const redactedPrTitle = redactSecrets(pr.title, knownSecrets).text;
  const redactedPrBody = redactSecrets(pr.body, knownSecrets).text;
  // Every prompt of the review, batches included, carries the follow-up (ADR-0030) and the skill
  // (ADR-0034). The skill is workspace text, redacted like the rules files: its name too, since it
  // is printed in the prompt's block markers.
  const skill = input.skill && {
    name: redactSecrets(input.skill.name, knownSecrets).text,
    content: redactSecrets(input.skill.content, knownSecrets).text,
  };
  const promptPr = promptPrOf(redactedPrTitle, redactedPrBody, followUp, skill);

  // Redact rules files
  // The path is printed in the REVIEW_CRITERIA block label, so it is redacted like the content.
  const redactedRulesFiles = rulesFiles.map((rf) => ({
    path: redactSecrets(rf.path, knownSecrets).text,
    content: redactSecrets(rf.content, knownSecrets).text,
  }));

  // Path instructions are workspace text too: redacted like the rules files, for every call.
  const redactedPathInstructions = reviewCfg.pathInstructions.map((pi) => ({
    path: redactSecrets(pi.path, knownSecrets).text,
    instructions: redactSecrets(pi.instructions, knownSecrets).text,
  }));
  const promptConfig = { ...config, review: { ...reviewCfg, pathInstructions: redactedPathInstructions } };

  // Redact patches; a secret on an added line becomes a security finding.
  const { files: redactedReviewableFiles, securityFindings } = redactPatches(reviewableFiles, knownSecrets);

  // Repository context, redacted with the same secrets; each call gets its own share (ADR-0029).
  const context = new ContextPlan(input.contextFiles ?? [], {
    exclude: reviewCfg.exclude,
    knownSecrets,
    reviewedPaths: redactedReviewableFiles.map((f) => f.path),
    contextTokens: reviewCfg.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    batchTokens: limits.batchTokens,
    batchContextTokens: reviewCfg.batchContextTokens,
    contextTokensPerFile: reviewCfg.contextTokensPerFile,
    // The rest of the PR is context on a follow-up review only (ADR-0030).
    prContextTokens: followUp ? (reviewCfg.prContextTokens ?? DEFAULT_PR_CONTEXT_TOKENS) : 0,
  });

  // ── Step c: build prompt + budget check ───────────────────────────────
  const notShown = renderNotShown(manifestFiles);
  const promptInput = {
    language: config.language,
    maxFindings: reviewCfg.maxFindings,
    pr: promptPr,
    rulesFiles: redactedRulesFiles,
    pathInstructions: redactedPathInstructions,
    files: redactedReviewableFiles,
    notShown,
    ...(input.libraryDocs ? { libraryDocs: input.libraryDocs } : {}),
  };
  const withoutContext = buildReviewPrompt(promptInput);
  const withoutContextTokens = estimateTokens(withoutContext.system + withoutContext.user);
  const wholePromptLimit = Math.min(limits.maxPromptTokens, budgetCfg.maxInputTokens);
  const contextRoom = Math.max(0, wholePromptLimit - withoutContextTokens - WHOLE_CONTEXT_SAFETY_TOKENS);
  const wholeContext = context.whole(contextRoom);
  let prompt = wholeContext.length > 0 ? buildReviewPrompt({ ...promptInput, contextFiles: wholeContext }) : withoutContext;
  let promptTokens = estimateTokens(prompt.system + prompt.user);
  // Long path labels can outgrow the estimated block overhead. Drop the lowest-priority files,
  // never split a review just to accommodate context, and disclose exactly what remains.
  while (promptTokens > wholePromptLimit && wholeContext.length > 0) {
    wholeContext.pop();
    prompt = buildReviewPrompt({ ...promptInput, contextFiles: wholeContext });
    promptTokens = estimateTokens(prompt.system + prompt.user);
  }

  // Token and cost budgets count only the context retained in the prompt.
  // A review that will be batched sends no whole-PR prompt: only its batches are checked, each
  // against maxInputTokens below, and their total below too. Counting the whole PR here would
  // skip a review whose batches fit, so the check is only for the unbatched review.
  const batched = withoutContextTokens > limits.maxPromptTokens && redactedReviewableFiles.length > 0;
  if (!batched) {
    const budgetResult = checkBudget({
      promptTokens,
      maxInputTokens: budgetCfg.maxInputTokens,
    });

    if (!budgetResult.ok) {
      return { status: 'skipped-budget', reason: budgetResult.reason };
    }
  }

  // Size guard (ADR-0013): a prompt too big for one reliable call goes straight to capped batches.
  let plan: CappedBatches | undefined;
  if (batched) {
    plan = batchFilesByTokenCap(redactedReviewableFiles, limits.batchTokens, reviewCfg.maxFileParts);
    // A file too big for one batch is reviewed in parts (ADR-0045); the parts beyond
    // review.maxFileParts are not sent, and the file is reported as not fully reviewed.
    for (const skipped of plan.skippedParts) {
      incompleteReasons.push(
        `${skipped.path}: parts ${skipped.from}–${skipped.total} of ${skipped.total} not reviewed (review.maxFileParts)`,
      );
    }
    // A line too big for the cap on its own was cut to fit: the file says so.
    for (const cut of plan.cutLines) {
      incompleteReasons.push(`${cut.path}: ${cut.count} over-long line(s) cut to fit review.batchTokens`);
    }
  } else {
    context.markSent(wholeContext);
  }
  const promptArgs = {
    config: promptConfig,
    pr: promptPr,
    rulesFiles: redactedRulesFiles,
    libraryDocs: input.libraryDocs,
    contextFor: context.forBatch,
    manifestFiles,
  };
  // Each batch prompt is priced with its context and its manifest.
  const callPromptTokens = plan
    ? plan.batches.map((_, index, batches) => {
        const batchPrompt = buildBatchPrompt({ ...promptArgs, batches }, index);
        return estimateTokens(batchPrompt.system + batchPrompt.user);
      })
    : [promptTokens];

  for (const callTokens of callPromptTokens) {
    const callBudget = checkBudget({ promptTokens: callTokens, maxInputTokens: budgetCfg.maxInputTokens });
    if (!callBudget.ok) return { status: 'skipped-budget', reason: callBudget.reason };
  }
  // A batched review sends no whole-PR prompt, but it does send every planned batch: their
  // total is the input the review really costs, so it is bounded as well (ADR-0045, rule 3).
  // Only the planned batches count: the parts beyond review.maxFileParts are never sent.
  if (plan) {
    const totalBudget = checkBudget({
      promptTokens: callPromptTokens.reduce((sum, tokens) => sum + tokens, 0),
      maxInputTokens: budgetCfg.maxInputTokens,
    });
    if (!totalBudget.ok) return { status: 'skipped-budget', reason: totalBudget.reason };
  }

  // Each call may return up to maxFindings findings, so its answer budget grows with them (ADR-0033).
  const maxOutputTokens = reviewOutputTokensFor(reviewCfg.maxFindings);
  // Price the output limit each call really requests: answer budget + effort's thinking headroom
  // (largest across the chain). Thinking is billed as output, so pricing less could overspend.
  const reviewOutputTokens = model.outputTokensFor(maxOutputTokens);
  // Worst case: every call returned its maxFindings findings, all of them verified.
  const verifyOutputTokens = model.outputTokensFor(verifyOutputTokensFor(reviewCfg.maxFindings * callPromptTokens.length));
  const initialPricing = currentPricing();
  if (initialPricing) {
    // Verification may use context from every batch, even when the whole-PR call had no room.
    // Price that union with the diff as a conservative bound on the verifier's capped code.
    const verifyContextPrompt = plan && reviewCfg.verify
      ? buildReviewPrompt({ ...promptInput, contextFiles: context.sentFiles() })
      : prompt;
    const estimatedCostUsd = estimateReviewCostUsd(
      {
        callPromptTokens,
        reviewOutputTokens,
        verifyPromptTokens: reviewCfg.verify ? estimateTokens(verifyContextPrompt.system + verifyContextPrompt.user) : undefined,
        verifyOutputTokens,
      },
      initialPricing,
    );
    if (estimatedCostUsd > budgetCfg.perReviewUsd) {
      return { status: 'skipped-budget', reason: costOverBudgetReason(estimatedCostUsd, budgetCfg.perReviewUsd) };
    }
  }

  // Real spend across every call of this review; usage-less calls count at their estimate.
  const spend = new SpendTracker(currentPricing, budgetCfg.perReviewUsd);

  // ── Steps d + e: model call(s), parse, recovery ────────────────────────
  // Read-only exploration before the answer (ADR-0046): only when the caller passes a reader,
  // and only in a single-call review; a batched one discloses that it did not explore.
  const explored = await exploreBeforeSinglePass({
    explore: input.explore, review: reviewCfg, batched: plan !== undefined, model, spend, deadline, signal,
    prompt, promptTokens, promptLimit: wholePromptLimit, files: redactedReviewableFiles, contextFiles: context.sentFiles(),
    knownSecrets, reviewOutputTokens, verifyReserve: reviewCfg.verify ? { promptTokens, outputTokens: verifyOutputTokens } : undefined,
  });

  const passContext: ReviewPassContext = {
    config: promptConfig,
    model,
    spend,
    knownSecrets,
    signal,
    deadline,
    prompt: explored.prompt,
    promptTokens: explored.promptTokens,
    maxOutputTokens,
    reviewOutputTokens,
    promptPr,
    redactedRulesFiles,
    redactedReviewableFiles,
    libraryDocs: input.libraryDocs,
    contextFor: context.forBatch,
    manifestFiles,
  };

  const pass = plan ? await runBatchedPass(passContext, plan.batches) : await runSinglePass(passContext);
  if (!pass.ok) {
    // Calls that answered before the failure were still paid for (ADR-0027 amendment).
    const disclosure = model.disclosure(knownSecrets);
    const failedCostUsd = knownCostUsd(model, disclosure, budgetCfg.pricing, spend);
    const failedUsage = combineUsage(pass.totalUsage, explored.usage);
    return {
      status: 'failed',
      reason: pass.reason,
      ...(pass.detail ? { detail: pass.detail } : {}),
      ...(pass.answerAttempts ? { answerAttempts: pass.answerAttempts } : {}),
      ...(failedUsage ? { usage: failedUsage } : {}),
      ...(failedCostUsd !== undefined ? { costUsd: failedCostUsd } : {}),
      ...explored.disclosure(),
      ...disclosure,
      onlySubscriptionCalls: model.onlySubscriptionCalls,
    };
  }
  let totalUsage = combineUsage(pass.totalUsage, explored.usage);
  incompleteReasons.push(...pass.incompleteReasons);
  // The answer budget of the model that answered the review (a fallback's own limit after a
  // fallback), read before verification can move the chain on: the summary then says the answer
  // may hold fewer findings (ADR-0033).
  const answerTokens = model.answerTokensFor(maxOutputTokens);
  const outputLimit: OutputLimitDisclosure | undefined =
    answerTokens < maxOutputTokens
      ? { maxFindings: reviewCfg.maxFindings, answerTokens, neededTokens: maxOutputTokens }
      : undefined;

  // ── Step e2: verification pass ─────────────────────────────────────────
  let modelFindings = pass.findings;
  let verification: { checked: number; rejected: number } | undefined;
  let verifyRejected: VerifyRejectedFinding[] = [];
  let verifyRejectedFindings: RejectedFinding[] = [];

  if (reviewCfg.verify && modelFindings.length > 0) {
    const verified = await runVerifyPass({
      language: config.language,
      findings: modelFindings,
      files: redactedReviewableFiles,
      notShown,
      contextFiles: context.sentFiles(),
      maxCodeTokens: limits.batchTokens,
      rulesFiles: redactedRulesFiles,
      pathInstructions: redactedPathInstructions,
      maxInputTokens: budgetCfg.maxInputTokens,
      model,
      spend,
      knownSecrets,
      totalUsage,
      signal,
      deadline,
      // The verifier explores too, from the same remaining read budget (ADR-0046).
      explore: explored.explorePass,
    });
    modelFindings = verified.findings;
    totalUsage = verified.totalUsage;
    verification = verified.verification;
    verifyRejected = verified.rejected;
    verifyRejectedFindings = verified.rejectedFindings ?? [];
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

  // Inline comments land only on lines of the reviewed files (PR patch lines when incremental).
  const patchIndex = anchorIndexOf(redactedReviewableFiles, input.anchorFiles);
  const { inline, summaryOnly } = anchorFindings(selected, patchIndex);

  // ── Step g: assemble result ────────────────────────────────────────────
  const complete = incompleteReasons.length === 0;
  // What the model noticed and did not report, redacted like the summary and the findings (ADR-0042).
  const withheld = redactWithheld(pass.withheld ?? [], knownSecrets);

  const result: ReviewResult = {
    summary: pass.summary,
    findings: selected,
    complete,
    incompleteReasons,
  };

  const contextDisclosure = context.disclosure();
  const disclosure = model.disclosure(knownSecrets);
  const reviewCostUsd = knownCostUsd(model, disclosure, budgetCfg.pricing, spend);

  return {
    status: 'completed',
    summary: pass.summary,
    inline,
    summaryOnly,
    ...(withheld.length > 0 ? { withheld } : {}),
    result,
    usage: totalUsage,
    ...(reviewCostUsd !== undefined ? { costUsd: reviewCostUsd } : {}),
    droppedInvalid: pass.droppedInvalid,
    complete,
    ...(verification !== undefined ? { verification } : {}),
    ...(verifyRejected.length > 0 ? { verifyRejected, verifyRejectedFindings } : {}),
    ...(judge ? { judge } : {}),
    ...(contextDisclosure ? { context: contextDisclosure } : {}),
    ...explored.disclosure(),
    ...(outputLimit ? { outputLimit } : {}),
    ...(pass.answerAttempts ? { answerAttempts: pass.answerAttempts } : {}),
    ...disclosure,
    onlySubscriptionCalls: model.onlySubscriptionCalls,
  };
}

/**
 * A review's cost, for completed and failed runs alike: $0 when every call was on a subscription.
 * Pricing belongs to the configured model, so after a model fallback the cost is unknown (tokens
 * still count). Otherwise it is the real cost where usage was reported and the estimate for calls
 * without usage (ADR-0011); a method-only fallback stays on the configured model, so its total is
 * known too (ADR-0027).
 */
function knownCostUsd(
  model: FallbackChain,
  disclosure: FallbackDisclosure,
  pricing: ModelPricing | undefined,
  spend: SpendTracker,
): number | undefined {
  if (model.onlySubscriptionCalls) return 0;
  const methodOnlyFallback =
    disclosure.fallbackFromMethod !== undefined && disclosure.modelUsed === disclosure.fallbackFrom;
  return pricing && (!disclosure.fallbackFrom || methodOnlyFallback) ? spend.spentUsd : undefined;
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

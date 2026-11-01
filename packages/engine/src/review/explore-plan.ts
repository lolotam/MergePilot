/** Input headroom and shared exploration state for whole-PR and batched reviews (ADR-0049). */
import type { ExploreLimits, MergePilotConfig } from '../config/schema.js';
import { estimateTokens } from './budget.js';
import type { ExecuteBatchedReviewInput } from './batch-run.js';
import { maxExploredBlockTokens, renderExploredBlock } from './explore-block.js';
import { ExploreBudget, exploreLimits, type ExploreInput } from './explore.js';
import { EXPLORED_SEPARATOR_TOKENS, uniqueExploreEntries, exploreInstructions, type ExploreEntry } from './explore-requests.js';
import { exploreBeforeSinglePass, type ExploreStepOptions, type ExploreStepResult } from './explore-step.js';
import { batchFilesByTokenCap, combineUsage, type CappedBatches, type ReviewableFileWithPatch } from './split.js';

// Balance diff coverage against evidence within the existing input cap.
const EXPLORATION_INPUT_SHARE = 0.2;
// Cover protocol fences and estimator rounding.
const EXPLORATION_HEADROOM_TOKENS = 32;
// Cover batch labels beyond the fixed prompt and manifest.
const BATCH_LABEL_TOKENS = 300;
// Initial allowance for rendered patch line numbers; actual prompts are remeasured.
const PATCH_RENDER_EXPANSION = 1.3;
// Converge conservatively when rendered short lines exceed the initial estimate.
const BATCH_REFIT_RATIO = 0.8;
// A smaller reserve must not turn ordinary patches into one-line parts.
const MIN_EXPLORATION_PATCH_TOKENS = 32;

/** Reserve at most 20% for results, plus the exact protocol instructions and fence headroom. */
export function explorationBaseLimit(limit: number, limits: ExploreLimits, enabled: boolean): number {
  if (!enabled) return limit;
  const instructions = estimateTokens(exploreInstructions('review', limits, limits.maxRounds, limits.maxRounds));
  return Math.max(1, limit - Math.min(limits.maxReadTokens, Math.floor(limit * EXPLORATION_INPUT_SHARE)) - instructions - EXPLORATION_HEADROOM_TOKENS);
}

/** A patch gains line numbers when rendered; leave room for them and batch labels as well. */
export function explorationBatchCap(cap: number, limit: number, emptyPrompt: { system: string; user: string }, manifest: string): number | undefined {
  const overhead = estimateTokens(emptyPrompt.system + emptyPrompt.user) + estimateTokens(manifest) + BATCH_LABEL_TOKENS;
  const fitted = Math.min(cap, Math.floor((limit - overhead) / PATCH_RENDER_EXPANSION));
  return fitted >= Math.min(cap, MIN_EXPLORATION_PATCH_TOKENS) ? fitted : undefined;
}

/** Falls back to the full input cap when reserving exploration would sacrifice diff coverage. */
export function planReviewExploration(opts: {
  explore: ExploreInput | undefined;
  limit: number;
  review: Pick<MergePilotConfig['review'], 'explore' | 'maxFileParts'>;
  batchTokens: number;
  files: ReviewableFileWithPatch[];
  wholePromptTokens: number;
  emptyPrompt: { system: string; user: string };
  manifest: string;
  promptFor: (batches: ReviewableFileWithPatch[][], index: number) => { system: string; user: string };
}): { basePromptLimit: number; plan?: CappedBatches | undefined; skipReason?: string | undefined; unfitReason?: string | undefined } {
  const basePromptLimit = explorationBaseLimit(opts.limit, exploreLimits(opts.review), opts.explore !== undefined);
  if (!opts.explore) return { basePromptLimit };
  // Batching needs files: a PR with none (it only removes or excludes files) always reviews in a
  // single pass, so an over-cap prompt there must fail the budget the ordinary checkBudget way,
  // and an over-reserve prompt skips the exploration reserve instead of planning impossible batches.
  if (opts.files.length === 0) {
    if (opts.wholePromptTokens > opts.limit) {
      return { basePromptLimit: opts.limit, unfitReason: `Estimated prompt tokens (${opts.wholePromptTokens}) exceed maxInputTokens limit (${opts.limit}).` };
    }
    if (opts.wholePromptTokens <= basePromptLimit) return { basePromptLimit };
    return { basePromptLimit: opts.limit, skipReason: 'exploration reserve leaves insufficient patch room' };
  }
  const cap = explorationBatchCap(opts.batchTokens, basePromptLimit, opts.emptyPrompt, opts.manifest);
  if (opts.wholePromptTokens <= basePromptLimit) return { basePromptLimit };
  const plan = cap !== undefined ? fitExplorationBatches(opts.files, cap, opts.review.maxFileParts, basePromptLimit, opts.promptFor) : undefined;
  if (plan) return { basePromptLimit, plan };
  const fallback = { basePromptLimit: opts.limit, skipReason: 'exploration reserve leaves insufficient patch room' };
  if (opts.wholePromptTokens <= opts.limit) return fallback;
  const fullCap = explorationBatchCap(opts.batchTokens, opts.limit, opts.emptyPrompt, opts.manifest);
  const fullPlan = fullCap === undefined ? undefined
    : fitExplorationBatches(opts.files, fullCap, opts.review.maxFileParts, opts.limit, opts.promptFor);
  // When not even the full input cap fits an exploration plan, run the ordinary batching pipeline:
  // its batch cap and per-batch budget checks fit what the exploration plans could not.
  return fullPlan ? { ...fallback, plan: fullPlan } : fallback;
}

/** Shares gathered originals and reserves repeated evidence against spend and total batch input. */
export async function exploreReview(opts: ExploreStepOptions & { callPromptTokens: number[]; totalInputLimit: number; skipReason?: string | undefined }): Promise<ExploreStepResult & { beforeBatch: ExecuteBatchedReviewInput['beforeBatch'] }> {
  const budget = opts.explore ? new ExploreBudget(exploreLimits(opts.review)) : undefined;
  const result = await exploreBeforeSinglePass({ ...opts, budget, batched: opts.batched || opts.skipReason !== undefined });
  if (opts.skipReason) budget?.noteSkipped(opts.skipReason);
  result.disclosure = () => budget ? { exploration: budget.disclosure() } : {};
  let gatheredEntries: readonly ExploreEntry[] = result.gatheredEntries;
  let sentInputTokens = 0;
  const beforeBatch: ExecuteBatchedReviewInput['beforeBatch'] = opts.explore && !opts.skipReason ? async (prompt, files, index) => {
    const remaining = opts.callPromptTokens.slice(index + 1);
    const promptTokens = estimateTokens(prompt.system + prompt.user);
    const remainingBaseTokens = remaining.reduce((sum, tokens) => sum + tokens, 0);
    const evidenceTokenLimit = Math.max(0, Math.floor((opts.totalInputLimit - sentInputTokens - promptTokens - remainingBaseTokens) / (remaining.length + 1)));
    // Every copy of this evidence rides a different batch prompt, and each prompt leaves its own
    // headroom: price the reserve copy by copy, so a roomy early batch cannot promise room later
    // batches do not have. Each copy also pays its separator.
    const limits = exploreLimits(opts.review);
    const blockMax = maxExploredBlockTokens(limits.maxReadTokens, limits.maxRounds * limits.maxRequestsPerRound);
    const perCopy = (headroom: number) => Math.min(evidenceTokenLimit, blockMax, Math.max(0, headroom)) + EXPLORED_SEPARATOR_TOKENS;
    const evidenceReserveTokens = perCopy(opts.promptLimit - promptTokens) +
      remaining.reduce((sum, tokens) => sum + perCopy(opts.promptLimit - tokens), 0);
    const step = await exploreBeforeSinglePass({
      ...opts, budget, prompt, files, batched: false, priorEntries: gatheredEntries,
      promptTokens, evidenceTokenLimit, additionalEvidenceCopies: remaining.length,
      evidenceReserveTokens, additionalReserveTokens: remainingBaseTokens,
      additionalReserveOutputTokens: opts.reviewOutputTokens * remaining.length,
    });
    sentInputTokens += step.promptTokens;
    result.usage = combineUsage(result.usage, step.usage);
    gatheredEntries = step.gatheredEntries;
    result.gatheredEntries = gatheredEntries;
    if (step.explorePass) {
      const entries = uniqueExploreEntries(gatheredEntries);
      result.explorePass = { ...step.explorePass, priorEntries: entries, priorBlock: renderExploredBlock(entries, opts.knownSecrets) };
    }
    return step.prompt;
  } : undefined;
  return Object.assign(result, { beforeBatch });
}

/** Re-measure rendered patches: short lines can gain far more than 30% from line numbers. */
export function fitExplorationBatches(files: ReviewableFileWithPatch[], initialCap: number, maxParts: number | undefined, limit: number, promptFor: (batches: ReviewableFileWithPatch[][], index: number) => { system: string; user: string }): CappedBatches | undefined {
  let cap = initialCap;
  for (;;) {
    const plan = batchFilesByTokenCap(files, cap, maxParts);
    const largest = Math.max(0, ...plan.batches.map((_, index) => {
      const prompt = promptFor(plan.batches, index);
      return estimateTokens(prompt.system + prompt.user);
    }));
    if (largest <= limit) return plan;
    cap = Math.max(1, Math.min(cap - 1, Math.floor(cap * limit / largest * BATCH_REFIT_RATIO)));
    if (cap < Math.min(initialCap, MIN_EXPLORATION_PATCH_TOKENS)) return undefined;
  }
}

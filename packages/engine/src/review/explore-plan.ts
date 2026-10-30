/** Input headroom and shared exploration state for whole-PR and batched reviews (ADR-0049). */
import type { ExploreLimits } from '../config/schema.js';
import { estimateTokens } from './budget.js';
import type { ExecuteBatchedReviewInput } from './batch-run.js';
import { renderExploredBlock } from './explore-block.js';
import { ExploreBudget, exploreLimits } from './explore.js';
import { uniqueExploreEntries, exploreInstructions } from './explore-requests.js';
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

/** Reserve at most 20% for results, plus the exact protocol instructions and fence headroom. */
export function explorationBaseLimit(limit: number, limits: ExploreLimits, enabled: boolean): number {
  if (!enabled) return limit;
  const instructions = estimateTokens(exploreInstructions('review', limits, limits.maxRounds, limits.maxRounds));
  return Math.max(1, limit - Math.min(limits.maxReadTokens, Math.floor(limit * EXPLORATION_INPUT_SHARE)) - instructions - EXPLORATION_HEADROOM_TOKENS);
}

/** A patch gains line numbers when rendered; leave room for them and batch labels as well. */
export function explorationBatchCap(cap: number, limit: number, emptyPrompt: { system: string; user: string }, manifest: string): number {
  const overhead = estimateTokens(emptyPrompt.system + emptyPrompt.user) + estimateTokens(manifest) + BATCH_LABEL_TOKENS;
  return Math.max(1, Math.min(cap, Math.floor((limit - overhead) / PATCH_RENDER_EXPANSION)));
}

export async function exploreReview(opts: ExploreStepOptions & { callPromptTokens: number[] }): Promise<ExploreStepResult & { beforeBatch: ExecuteBatchedReviewInput['beforeBatch'] }> {
  const budget = opts.explore ? new ExploreBudget(exploreLimits(opts.review)) : undefined;
  const result = await exploreBeforeSinglePass({ ...opts, budget, remainingAnswers: 1 });
  result.disclosure = () => budget ? { exploration: budget.disclosure() } : {};
  const beforeBatch: ExecuteBatchedReviewInput['beforeBatch'] = opts.explore ? async (prompt, files, index, remainingAnswers) => {
    const remaining = opts.callPromptTokens.slice(index + 1);
    const step = await exploreBeforeSinglePass({
      ...opts, budget, prompt, files, batched: false, remainingAnswers, priorEntries: result.explorePass?.priorEntries,
      promptTokens: estimateTokens(prompt.system + prompt.user),
      additionalReserveTokens: remaining.reduce((sum, tokens) => sum + tokens, 0),
      additionalReserveOutputTokens: opts.reviewOutputTokens * remaining.length,
    });
    result.usage = combineUsage(result.usage, step.usage);
    if (step.explorePass) {
      const entries = uniqueExploreEntries([...(result.explorePass?.priorEntries ?? []), ...(step.explorePass.priorEntries ?? [])]);
      result.explorePass = { ...step.explorePass, priorEntries: entries, priorBlock: renderExploredBlock(entries, opts.knownSecrets) };
    }
    return step.prompt;
  } : undefined;
  return Object.assign(result, { beforeBatch });
}

/** Re-measure rendered patches: short lines can gain far more than 30% from line numbers. */
export function fitExplorationBatches(files: ReviewableFileWithPatch[], initialCap: number, maxParts: number | undefined, limit: number, promptFor: (batches: ReviewableFileWithPatch[][], index: number) => { system: string; user: string }): CappedBatches {
  let cap = initialCap;
  for (;;) {
    const plan = batchFilesByTokenCap(files, cap, maxParts);
    const largest = Math.max(0, ...plan.batches.map((_, index) => {
      const prompt = promptFor(plan.batches, index);
      return estimateTokens(prompt.system + prompt.user);
    }));
    if (largest <= limit || cap <= 1) return plan;
    cap = Math.max(1, Math.min(cap - 1, Math.floor(cap * limit / largest * BATCH_REFIT_RATIO)));
  }
}

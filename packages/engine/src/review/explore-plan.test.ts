import { describe, expect, it } from 'vitest';
import { buildBatchPrompt, executeBatchedReview } from './batch-run.js';
import { estimateTokens, parseBudgetSkipReason } from './budget.js';
import { ReviewDeadline } from './call.js';
import { fitExploredEntries, maxExploredBlockTokens, renderExploredBlock } from './explore-block.js';
import { exploreReview, planReviewExploration } from './explore-plan.js';
import { EXPLORED_SEPARATOR_TOKENS, exploreInstructions, type ExploreEntry } from './explore-requests.js';
import { EXPLORE_OUTPUT_TOKENS, exploreLimits, type RepositoryReader } from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { SpendTracker } from './spend.js';
import type { ReviewableFileWithPatch } from './split.js';

const reader: RepositoryReader = {
  readFile: async () => `${'evidence '.repeat(650)}\nTAIL_EVIDENCE`,
  listDirectory: async () => null,
  listPaths: async () => null,
};
const readAnswer = JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] });

describe('review-wide exploration evidence', () => {
  it('keeps originals through repeated trims and gives later batches and verification one full copy', async () => {
    const prompts = [1100, 1500, 1].map((count) => ({ system: 'system', user: 'patch '.repeat(count) }));
    const review = { exclude: [], explore: { maxRounds: 1, maxReadTokens: 5000 } };
    const model: ReviewModel = { label: 'fake:carry', generate: async () => ({ text: readAnswer, finishReason: 'stop' }) };
    const explored = await exploreReview({
      explore: { reader }, review, batched: true, model, spend: new SpendTracker(undefined, 1),
      deadline: new ReviewDeadline(60000), prompt: prompts[0]!, promptTokens: 0, promptLimit: 3000,
      callPromptTokens: prompts.map((prompt) => estimateTokens(prompt.system + prompt.user)), totalInputLimit: 20000,
      files: [], contextFiles: [], knownSecrets: [], reviewOutputTokens: 100,
    });
    const answers = [];
    for (const [index, prompt] of prompts.entries()) answers.push(await explored.beforeBatch!(prompt, [], index));

    expect(answers[0]!.user).toContain('[explored result truncated');
    expect(answers[1]!.user).toContain('[explored result truncated');
    expect(answers[2]!.user).toContain('TAIL_EVIDENCE');
    expect(answers[2]!.user).not.toContain('[explored result truncated');
    expect(answers[2]!.user.match(/<<<UNTRUSTED:EXPLORED:src\/guard.ts>>>/g)).toHaveLength(1);
    expect(explored.gatheredEntries).toHaveLength(1);
    expect(explored.explorePass?.priorEntries).toHaveLength(1);
    expect(explored.explorePass?.priorBlock).toContain('TAIL_EVIDENCE');
    expect(explored.explorePass?.priorBlock).not.toContain('[explored result truncated');
  });

  it.each(['money', 'money-affordable', 'input'] as const)('protects all batch answers against repeated evidence exceeding the %s cap', async (cap) => {
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = { label: 'fake:reserve', generate: async (request) => {
      requests.push(request);
      return { text: request.system.includes('EXPLORATION (round') ? readAnswer : makeAnswerJson([]), finishReason: 'stop' };
    } };
    const config = makeConfig();
    const batches = ['a', 'b', 'c'].map((name) => [{ path: `src/${name}.ts`, patch: SIMPLE_PATCH }]);
    const promptInput = { batches, config, pr: { title: 'PR', body: '' }, rulesFiles: [] };
    const prompts = batches.map((_, index) => buildBatchPrompt(promptInput, index));
    const callPromptTokens = prompts.map((prompt) => estimateTokens(prompt.system + prompt.user));
    const baseTokens = callPromptTokens.reduce((sum, tokens) => sum + tokens, 0);
    const perReviewUsd = (baseTokens + (cap === 'money-affordable' ? 10000 : 5000)) / 1000;
    const spend = new SpendTracker(cap !== 'input' ? { inputPerMTok: 1000, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } : undefined, perReviewUsd);
    const totalInputLimit = baseTokens + (cap === 'input' ? 1000 : 30000);
    const explored = await exploreReview({
      explore: { reader }, review: { exclude: [], explore: { maxRounds: 1, maxRequestsPerRound: 1, maxReadTokens: 2000 } },
      batched: true, model, spend, deadline: new ReviewDeadline(60000),
      prompt: prompts[0]!, promptTokens: callPromptTokens[0]!, promptLimit: 10000,
      callPromptTokens, totalInputLimit, files: [], contextFiles: [], knownSecrets: [], reviewOutputTokens: 100,
    });
    const result = await executeBatchedReview({
      ...promptInput, beforeBatch: explored.beforeBatch, model, spend,
      maxOutputTokens: 100, retryOutputTokens: 200, reviewOutputTokens: 100,
    });
    const answers = requests.filter((request) => !request.system.includes('EXPLORATION (round'));

    expect(result.merged).not.toBeNull();
    expect(result.incompleteReasons).toEqual([]);
    expect(answers).toHaveLength(batches.length);
    expect(answers.reduce((sum, request) => sum + estimateTokens(request.system + request.user), 0)).toBeLessThanOrEqual(totalInputLimit);
    expect(spend.spentUsd).toBeLessThanOrEqual(perReviewUsd);
    if (cap !== 'money') {
      expect(requests.filter((request) => request.system.includes('EXPLORATION (round'))).toHaveLength(1);
      expect(answers.every((request) => request.user.includes('evidence'))).toBe(true);
    }
  });
});

describe('planReviewExploration without reviewable files (B23)', () => {
  const emptyPrompt = { system: '', user: '' };
  const review = makeConfig().review;
  const planOf = (over: Partial<Parameters<typeof planReviewExploration>[0]>) => planReviewExploration({
    explore: { reader }, limit: 1000, review, batchTokens: 500, files: [],
    wholePromptTokens: 10, emptyPrompt, manifest: '', promptFor: () => emptyPrompt, ...over,
  });

  it('skips the exploration reserve when a zero-file prompt outgrows it but fits the cap', () => {
    const result = planOf({ wholePromptTokens: 900 });
    expect(result).toEqual({ basePromptLimit: 1000, skipReason: 'exploration reserve leaves insufficient patch room' });
  });

  it('fails a zero-file PR whose prompt exceeds the input cap in the budget-skip format', () => {
    const result = planOf({ wholePromptTokens: 4000 });
    expect(result).toEqual({ basePromptLimit: 1000, unfitReason: 'Estimated prompt tokens (4000) exceed maxInputTokens limit (1000).' });
    expect(parseBudgetSkipReason(result.unfitReason!)).toEqual({ kind: 'input-tokens', promptTokens: 4000, maxInputTokens: 1000 });
  });

  it('keeps exploring a zero-file PR whose prompt fits its reserve', () => {
    const result = planOf({});
    expect(result.unfitReason).toBeUndefined();
    expect(result.skipReason).toBeUndefined();
    expect(result.plan).toBeUndefined();
    expect(result.basePromptLimit).toBeLessThan(1000);
  });

  it('falls back to ordinary batching where the exploration plans cannot fit, without marking the review unfit (B23)', () => {
    const files: ReviewableFileWithPatch[] = [{ path: 'src/a.ts', patch: SIMPLE_PATCH }];
    const result = planOf({ files, wholePromptTokens: 2000, manifest: 'm'.repeat(5000) });
    expect(result).toEqual({ basePromptLimit: 1000, skipReason: 'exploration reserve leaves insufficient patch room' });
    expect(result.unfitReason).toBeUndefined();
  });
});

it('prices the evidence reserve copy by copy so a tight later batch keeps sharing evidence (B23)', async () => {
  const promptLimit = 1000;
  const review = { exclude: [], explore: { maxRounds: 1, maxRequestsPerRound: 1, maxReadTokens: 3000 } };
  const limits = exploreLimits(review);
  const promptA = { system: 'review system', user: 'patch ' };
  const promptB = { system: 'review system', user: 'patch '.repeat(523) };
  const promptATokens = estimateTokens(promptA.system + promptA.user);
  const promptBTokens = estimateTokens(promptB.system + promptB.user);
  // Batch B's own prompt nearly fills the input cap: its headroom is far below batch A's, but
  // still enough to show a trimmed copy of the same evidence.
  expect(promptBTokens).toBeGreaterThan(895);
  expect(promptBTokens).toBeLessThan(910);
  const entry: ExploreEntry = { label: 'src/guard.ts', content: 'evidence '.repeat(40) };
  const read = JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] });
  const model: ReviewModel = {
    label: 'fake:per-copy',
    outputTokensFor: (tokens) => tokens,
    generate: async (request) => ({
      text: request.system.includes('EXPLORATION (round') ? read : makeAnswerJson([]),
      finishReason: 'stop',
    }),
  };
  // The exploration's one round, with the evidence block carried: what batching A's step prices.
  const roundSystem = `${promptA.system}\n\n${exploreInstructions('review', limits, 1, 1)}`;
  const blockRoom = promptLimit - estimateTokens(roundSystem + promptA.user) - EXPLORED_SEPARATOR_TOKENS;
  const blockA = renderExploredBlock(fitExploredEntries([entry], [], blockRoom), []);
  const promptAWithBlock = estimateTokens(promptA.system + `${promptA.user}\n\n${blockA}`);
  const blockMax = maxExploredBlockTokens(3000, limits.maxRounds * limits.maxRequestsPerRound);
  const sharedTokens = Math.floor((20000 - promptATokens - promptBTokens) / 2);
  expect(blockMax).toBeGreaterThan(promptLimit);
  expect(sharedTokens).toBeGreaterThan(promptLimit);
  // The caller's per-copy pricing: each copy pays its own prompt headroom plus one separator.
  const reserve = (promptLimit - promptATokens + EXPLORED_SEPARATOR_TOKENS) +
    (promptLimit - promptBTokens + EXPLORED_SEPARATOR_TOKENS);
  // What the round must fit with that pricing: its prompt, every batch's own base prompt, the
  // evidence reserve, and the round call's requested output plus the reviews' answer reserves.
  const affordTokens = promptAWithBlock + promptATokens + promptBTokens + reserve + EXPLORE_OUTPUT_TOKENS + 200;
  // What attaching the block at batch A must fit: each answer pays the same reserve share again.
  const attachTokens = (promptATokens + promptBTokens) + (promptAWithBlock - promptATokens) * 2 + 200;
  const limitTokens = Math.max(affordTokens, attachTokens) + 32;
  // Under the old pricing (batch A's own evidence room multiplied by the copy count, no
  // separators), the round would be priced above this limit and run no round at all.
  expect(limitTokens).toBeLessThan(
    promptAWithBlock + promptATokens + promptBTokens + (promptLimit - promptATokens) * 2 + EXPLORE_OUTPUT_TOKENS + 200,
  );
  const spend = new SpendTracker({ inputPerMTok: 1000, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }, limitTokens / 1000);
  const localReader: RepositoryReader = {
    readFile: async () => entry.content,
    listDirectory: async () => null,
    listPaths: async () => null,
  };
  const explored = await exploreReview({
    explore: { reader: localReader }, review, batched: true, model, spend,
    deadline: new ReviewDeadline(60000), prompt: promptA, promptTokens: promptATokens, promptLimit,
    callPromptTokens: [promptATokens, promptBTokens], totalInputLimit: 20000,
    files: [], contextFiles: [], knownSecrets: [], reviewOutputTokens: 100,
  });
  const answerA = await explored.beforeBatch!(promptA, [], 0);
  const answerB = await explored.beforeBatch!(promptB, [], 1);

  expect(explored.gatheredEntries).toHaveLength(1);
  expect(explored.explorePass).toBeDefined();
  expect(explored.explorePass?.priorEntries).toHaveLength(1);
  expect(answerA?.user).toContain('evidence');
  expect(answerB?.user).toContain('[explored result truncated');
  expect(estimateTokens(answerA!.system + answerA!.user)).toBeLessThanOrEqual(promptLimit);
  expect(estimateTokens(answerB!.system + answerB!.user)).toBeLessThanOrEqual(promptLimit);
  expect(spend.spentUsd).toBeLessThanOrEqual(limitTokens / 1000);
});

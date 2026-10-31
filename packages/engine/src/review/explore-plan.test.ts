import { describe, expect, it } from 'vitest';
import { buildBatchPrompt, executeBatchedReview } from './batch-run.js';
import { estimateTokens } from './budget.js';
import { ReviewDeadline } from './call.js';
import { exploreReview } from './explore-plan.js';
import type { RepositoryReader } from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { SpendTracker } from './spend.js';

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

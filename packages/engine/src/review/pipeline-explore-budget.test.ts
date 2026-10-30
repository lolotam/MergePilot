import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import type { RepositoryReader } from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview, type RunReviewInput } from './pipeline.js';

function recordingModel(answers: string[] = []): { model: ReviewModel; requests: ReviewModelRequest[] } {
  const requests: ReviewModelRequest[] = [];
  return {
    requests,
    model: {
      label: 'fake:explore-pipeline',
      generate: async (request) => {
        requests.push(request);
        return { text: answers.shift() ?? makeAnswerJson([]), finishReason: 'stop' };
      },
    },
  };
}

function fakeReader(files: Record<string, string> = {}): RepositoryReader {
  return {
    async readFile(path) {
      return files[path] ?? null;
    },
    async listDirectory() {
      return null;
    },
    async listPaths() {
      return null;
    },
  };
}

/** A patch of about `lines` × 8 estimated tokens. */
function bigPatch(lines: number): string {
  return `@@ -1,1 +1,${lines + 1} @@\n const a = 1;\n${Array.from({ length: lines }, (_, i) => `+const value${i} = ${i};`).join('\n')}`;
}

function input(
  model: ReviewModel,
  overrides: Partial<RunReviewInput> = {},
  review: Record<string, unknown> = {},
): RunReviewInput {
  const base = makeConfig();
  return {
    config: makeConfig({ review: { ...base.review, verify: false, ...review } }),
    pr: { title: 'PR', body: '' },
    files: [{ path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model,
    knownSecrets: [],
    ...overrides,
  };
}

const READ_GUARD = JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] });
describe('large PR exploration budgets (B23)', () => {
  it('explores every batch of a large patch without exceeding the input cap (B23)', async () => {
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = { label: 'fake:large', generate: async (request) => {
      requests.push(request);
      return { text: request.system.includes('EXPLORATION (round') ? READ_GUARD : makeAnswerJson([]), finishReason: 'stop' };
    } };
    const base = makeConfig();
    const result = await runReview(input(model, {
      files: [{ path: 'src/a.ts', status: 'modified', patch: bigPatch(900), changes: 901 }],
      config: makeConfig({ review: { ...base.review, verify: false, maxPromptTokens: 6000, batchTokens: 5000, explore: { maxRounds: 1 } }, budget: { ...base.budget, maxInputTokens: 30000 } }),
      explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
    }));
    const answers = requests.filter((r) => !r.system.includes('EXPLORATION (round'));
    expect(answers.length).toBeGreaterThan(1);
    expect(answers.every((r) => r.user.includes('EXPLORED:src/guard.ts'))).toBe(true);
    expect(requests.every((r) => estimateTokens(r.system + r.user) <= 6000)).toBe(true);
    expect(result).toMatchObject({ status: 'completed', exploration: { filesRead: ['src/guard.ts'] } });
  });

  it('reserves room when a whole PR patch nearly fills the input cap (B23)', async () => {
    const probe = recordingModel();
    const files = [{ path: 'src/a.ts', status: 'modified', patch: bigPatch(300), changes: 301 }];
    await runReview(input(probe.model, { files }));
    const cap = estimateTokens(probe.requests[0]!.system + probe.requests[0]!.user) + 20;
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = { label: 'fake:full', generate: async (request) => {
      requests.push(request);
      return { text: request.system.includes('EXPLORATION (round') ? READ_GUARD : makeAnswerJson([]), finishReason: 'stop' };
    } };
    await runReview(input(model, { files, explore: { reader: fakeReader({ 'src/guard.ts': 'guard evidence' }) } }, { maxPromptTokens: cap, explore: { maxRounds: 1 } }));
    expect(requests.some((r) => r.system.includes('EXPLORATION (round'))).toBe(true);
    const answers = requests.filter((r) => !r.system.includes('EXPLORATION (round'));
  expect(answers.length).toBeGreaterThan(1);
  expect(answers.every((r) => r.user.includes('guard evidence'))).toBe(true);
    expect(requests.every((r) => estimateTokens(r.system + r.user) <= cap)).toBe(true);
  });

});

it('fits short added lines whose rendered line numbers outgrow the raw patch estimate', async () => {
  const requests: ReviewModelRequest[] = [];
  const model: ReviewModel = { label: 'fake:short-lines', generate: async (request) => {
    requests.push(request);
    return { text: request.system.includes('EXPLORATION (round') ? READ_GUARD : makeAnswerJson([]), finishReason: 'stop' };
  } };
  await runReview(input(model, {
    files: [{ path: 'src/a.ts', status: 'modified', patch: '@@ -0,0 +1,2000 @@\n' + '+x\n'.repeat(2000), changes: 2000 }],
    explore: { reader: fakeReader({ 'src/guard.ts': 'guard evidence' }) },
  }, { maxPromptTokens: 4000, batchTokens: 3000, maxFileParts: 50, explore: { maxRounds: 1 } }));
  const answers = requests.filter((r) => !r.system.includes('EXPLORATION (round'));
  expect(answers.length).toBeGreaterThan(1);
  expect(answers.every((r) => r.user.includes('guard evidence'))).toBe(true);
  expect(requests.every((r) => estimateTokens(r.system + r.user) <= 4000)).toBe(true);
});

it('shares exhausted read evidence across batches and accounts for every call', async () => {
  const requests: ReviewModelRequest[] = [];
  let reads = 0;
  const model: ReviewModel = { label: 'fake:shared', generate: async (request) => {
    requests.push(request);
    return { text: request.system.includes('EXPLORATION (round') ? READ_GUARD : makeAnswerJson([]), finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 3 } };
  } };
  const result = await runReview(input(model, {
    files: [{ path: 'src/a.ts', status: 'modified', patch: bigPatch(900), changes: 901 }],
    explore: { reader: { ...fakeReader(), readFile: async () => { reads++; return 'guard evidence\n'.repeat(500); } } },
  }, { maxPromptTokens: 6000, batchTokens: 3000, explore: { maxRounds: 1, maxReadTokens: 100 } }));
  const answers = requests.filter((r) => !r.system.includes('EXPLORATION (round'));
  expect(answers.length).toBeGreaterThan(1);
  expect(answers.every((r) => r.user.includes('guard evidence'))).toBe(true);
  expect(reads).toBe(1);
  expect(result).toMatchObject({ status: 'completed', usage: { inputTokens: requests.length * 7, outputTokens: requests.length * 3 } });
});

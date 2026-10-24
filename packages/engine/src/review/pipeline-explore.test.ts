/**
 * The exploration in the pipeline (ADR-0046): a review without a reader is untouched, a review
 * with one carries the explored files in its prompt, a batched review discloses that it did not
 * explore, and the verifier explores as well.
 */

import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import type { RepositoryReader } from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
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
const NOTHING = JSON.stringify({ explore: [] });

describe('the exploration in the pipeline (ADR-0046)', () => {
  it('sends exactly the same requests as before when no reader is passed', async () => {
    const { model, requests } = recordingModel([makeAnswerJson([])]);

    const result = await runReview(input(model));

    expect(requests).toHaveLength(1);
    expect(result.status === 'completed' && result.exploration).toBeUndefined();
  });

  it('ends the review prompt with the explored block and discloses the exploration', async () => {
    const { model, requests } = recordingModel([READ_GUARD, NOTHING, makeAnswerJson([])]);

    const result = await runReview(input(model, {
      explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
    }));

    // Two exploration rounds (the read, then "nothing more") and the review call.
    expect(requests).toHaveLength(3);
    expect(requests[2]!.user).toContain('EXPLORED (read-only files and searches you asked for');
    expect(requests[2]!.user).toContain('<<<UNTRUSTED:EXPLORED:src/guard.ts>>>');
    expect(requests[2]!.user.trimEnd().endsWith('<<<END UNTRUSTED:EXPLORED:src/guard.ts>>>')).toBe(true);
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 2, requests: 1, filesRead: ['src/guard.ts'], refused: 0 },
    });
  });

  it('does not explore a batched review and says so', async () => {
    const files = ['src/a.ts', 'src/b.ts'].map((path) => ({
      path,
      status: 'modified',
      patch: bigPatch(100),
      changes: 101,
    }));
    const { model, requests } = recordingModel([makeAnswerJson([]), makeAnswerJson([])]);

    const result = await runReview(input(model, {
      files,
      explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
    }, { maxPromptTokens: 1_000, batchTokens: 800 }));

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.user.includes('EXPLORED ('))).toBe(true);
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 0, requests: 0, filesRead: [], refused: 0, skipped: 'batched review' },
    });
  });

  it('gives the verifier its own explored block when the review explored', async () => {
    const { model, requests } = recordingModel([
      READ_GUARD,
      NOTHING,
      makeAnswerJson([validFindingJson()]),
      JSON.stringify({ explore: [{ read: { path: 'src/other.ts' } }] }),
      JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'shown' }] }),
    ]);

    const result = await runReview(input(model, {
      explore: {
        reader: fakeReader({
          'src/guard.ts': 'export function guard() {}',
          'src/other.ts': 'export const other = 1;',
        }),
      },
    }, { verify: true }));

    // Two exploration rounds, the review, the verifier's own round and the verify call.
    expect(requests).toHaveLength(5);
    expect(requests[4]!.user).toContain('EXPLORED (read-only files and searches you asked for');
    expect(requests[4]!.user).toContain('<<<UNTRUSTED:EXPLORED:src/other.ts>>>');
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 3, requests: 2, filesRead: ['src/guard.ts', 'src/other.ts'] },
    });
  });

  it('keeps the review prompt when the explored results do not fit the input limit', async () => {
    const baseline = recordingModel([makeAnswerJson([])]);
    await runReview(input(baseline.model));
    const baseTokens = estimateTokens(baseline.requests[0]!.system + baseline.requests[0]!.user);

    const { model, requests } = recordingModel([READ_GUARD, NOTHING, makeAnswerJson([])]);
    const result = await runReview(input(model, {
      explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
    }, { maxPromptTokens: baseTokens + 20 }));

    expect(requests).toHaveLength(3);
    expect(requests[2]!.user).not.toContain('EXPLORED (');
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { skipped: 'explored results did not fit the input-token limit' },
    });
  });

  it('keeps the money of the review call out of the exploration', async () => {
    const { model, requests } = recordingModel([makeAnswerJson([])]);
    const base = makeConfig();
    const config = makeConfig({
      review: { ...base.review, verify: false },
      budget: {
        ...base.budget,
        perReviewUsd: 20,
        pricing: { inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 1000, cacheWritePerMTok: 1000 },
      },
    });

    const result = await runReview({
      ...input(model, {
        explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
      }),
      config,
    });

    // The exploration does not fit next to the reserved review call: the review runs anyway.
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 0, requests: 0, filesRead: [], refused: 0, skipped: 'budget limit reached' },
    });
  });
});

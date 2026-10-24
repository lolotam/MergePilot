/**
 * The exploration in the pipeline (ADR-0046): a review without a reader is untouched, a review
 * with one carries the explored files in its prompt, a batched review discloses that it did not
 * explore, and the verifier explores as well. The verifier's own round is checked here too: what
 * it shows again, the prompt it sends when the spend runs out, and the call it skips when the
 * deadline runs out.
 */

import { describe, expect, it } from 'vitest';
import type { ExploreLimits } from '../config/schema.js';
import { estimateTokens } from './budget.js';
import { JSON_ONLY_REMINDER, ReviewDeadline } from './call.js';
import { renderExploredBlock } from './explore-block.js';
import {
  ExploreBudget,
  type ExplorePassInput,
  type RepositoryReader,
} from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type RunReviewInput } from './pipeline.js';
import { SpendTracker } from './spend.js';
import { runVerifyPass, type VerifyPassInput } from './verify-pass.js';

const LIMITS: ExploreLimits = {
  maxRounds: 3,
  maxRequestsPerRound: 8,
  maxReadTokens: 30_000,
  maxLinesPerRead: 400,
};

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

/** A read of this file costs exactly the read budget of the review, so the budget ends with it. */
const BIG_FILE = 'x'.repeat(3494);
const READ_BIG = JSON.stringify({ explore: [{ read: { path: 'src/big.ts' } }] });
const VERDICTS = JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'shown' }] });

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

  it('gives the verifier the explored block of the review and its own', async () => {
    const { model, requests } = recordingModel([
      READ_GUARD,
      NOTHING,
      makeAnswerJson([validFindingJson()]),
      JSON.stringify({ explore: [{ read: { path: 'src/other.ts' } }] }),
      VERDICTS,
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
    // The verifier judges against what the review read, and against what it read itself.
    expect(requests[4]!.user).toContain('<<<UNTRUSTED:EXPLORED:src/guard.ts>>>');
    expect(requests[4]!.user).toContain('<<<UNTRUSTED:EXPLORED:src/other.ts>>>');
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 3, requests: 2, filesRead: ['src/guard.ts', 'src/other.ts'] },
    });
  });

  it('gives the verifier the explored block of the review when the read budget is used up', async () => {
    const { model, requests } = recordingModel([
      READ_BIG,
      makeAnswerJson([validFindingJson()]),
      VERDICTS,
    ]);

    const result = await runReview(input(model, {
      explore: { reader: fakeReader({ 'src/big.ts': BIG_FILE }) },
    }, { verify: true, explore: { maxReadTokens: 1000 } }));

    // The review's round, the review call and the verify call: the budget was used up, so the
    // verifier did not explore, but it still sees what the review read.
    expect(requests).toHaveLength(3);
    expect(requests.filter((request) => request.system.includes('EXPLORATION (round'))).toHaveLength(1);
    expect(requests[2]!.user).toContain('<<<UNTRUSTED:EXPLORED:src/big.ts>>>');
    expect(requests[2]!.user).toContain('x'.repeat(200));
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 1, requests: 1, filesRead: ['src/big.ts'] },
    });
  });

  it('keeps the review prompt when the explored results do not fit the input limit', async () => {
    // The prompt of an exploration round, measured with a review that explores.
    const probe = recordingModel([READ_GUARD, NOTHING, makeAnswerJson([])]);
    await runReview(input(probe.model, {
      explore: { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) },
    }));
    const roundTokens = estimateTokens(probe.requests[0]!.system + probe.requests[0]!.user);
    // A read whose block is bigger than the room the limit leaves for the round's instructions.
    const { model, requests } = recordingModel([READ_BIG, makeAnswerJson([])]);
    const result = await runReview(input(model, {
      explore: { reader: fakeReader({ 'src/big.ts': 'x'.repeat(4000) }) },
    }, { maxPromptTokens: roundTokens + 10 }));

    // The exploration round ran, but its result does not fit the review prompt.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.user).not.toContain('EXPLORED (');
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

  it('keeps the money of the verification call out of the exploration', async () => {
    const base = makeConfig();
    const pricing = { inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 1000, cacheWritePerMTok: 1000 };
    const explore = { reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }) };
    // The prompt of the review call, measured without an exploration.
    const baseline = recordingModel([makeAnswerJson([])]);
    await runReview(input(baseline.model));
    const reviewTokens = estimateTokens(baseline.requests[0]!.system + baseline.requests[0]!.user);
    // The prompt of an exploration round, measured with a review that explores and verifies nothing.
    const probe = recordingModel([READ_GUARD, NOTHING, makeAnswerJson([])]);
    await runReview({
      ...input(probe.model, { explore }),
      config: makeConfig({
        review: { ...base.review, verify: false, explore: { maxReadTokens: 1000 } },
        budget: { ...base.budget, perReviewUsd: 100, pricing },
      }),
    });
    const roundTokens = estimateTokens(probe.requests[0]!.system + probe.requests[0]!.user);
    // The spend that pays for the review call, the verification call and the exploration beside
    // them, but not for the exploration beside the verification call as well. The prices are 1000
    // per million tokens, so a thousand tokens cost a dollar: the read budget (1000), the answer
    // of an exploration round (2000) and the answer of the review call (4096).
    const perReviewUsd = (roundTokens + reviewTokens + 1000 + 2000 + 4096) / 1000 + 0.0001;
    const { model, requests } = recordingModel([makeAnswerJson([])]);

    const result = await runReview({
      ...input(model, { explore }),
      config: makeConfig({
        review: { ...base.review, verify: true, explore: { maxReadTokens: 1000 } },
        budget: { ...base.budget, perReviewUsd, pricing },
      }),
    });

    // The exploration does not fit next to the reserved review and verification calls.
    expect(requests.filter((request) => request.system.includes('EXPLORATION (round'))).toHaveLength(0);
    expect(result).toMatchObject({
      status: 'completed',
      exploration: { rounds: 0, requests: 0, filesRead: [], refused: 0, skipped: 'budget limit reached' },
    });
  });
});

/** The verification call the pipeline makes, with the exploration the review left it. */
function verifyInput(
  model: ReviewModel,
  overrides: Partial<VerifyPassInput> = {},
): VerifyPassInput {
  return {
    language: 'en',
    findings: [],
    files: [],
    model,
    spend: new SpendTracker(undefined, 0.5),
    knownSecrets: [],
    totalUsage: undefined,
    maxInputTokens: 1_000_000,
    ...overrides,
  };
}

/** The exploration the verifier runs: the reader, the budget and the review's results. */
function explorePass(overrides: Partial<ExplorePassInput> = {}): ExplorePassInput {
  return {
    reader: fakeReader({ 'src/guard.ts': 'export function guard() {}' }),
    budget: new ExploreBudget(LIMITS),
    heldTexts: { texts: new Map(), patches: new Set() },
    allowPath: () => true,
    limits: LIMITS,
    priorBlock: '',
    priorEntries: [],
    ...overrides,
  };
}

describe("the verifier's own exploration (ADR-0046)", () => {
  const READ_GUARD_JSON = JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] });
  // The entry the review's exploration gathered: the file at the head, with its line numbers.
  const PRIOR_ENTRIES = [{ label: 'src/guard.ts', content: '1| export function guard() {}' }];

  it('does not show the review\'s entry again when its block is in the verifier\'s prompt', async () => {
    const { model, requests } = recordingModel([READ_GUARD_JSON, VERDICTS]);

    const result = await runVerifyPass(verifyInput(model, {
      explore: explorePass({
        priorBlock: renderExploredBlock(PRIOR_ENTRIES, []),
        priorEntries: PRIOR_ENTRIES,
      }),
    }));

    // The verifier read the same file again, and its block did not repeat the review's entry.
    expect(requests).toHaveLength(2);
    const markers = requests[1]!.user.match(/<<<UNTRUSTED:EXPLORED:src\/guard\.ts>>>/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(result.incompleteReasons).toEqual([]);
  });

  it('shows the entry again when the review\'s block did not fit the verifier\'s prompt', async () => {
    // The prompt of the verifier\'s own round, measured without a prior block.
    const probe = recordingModel([NOTHING, VERDICTS]);
    await runVerifyPass(verifyInput(probe.model, { explore: explorePass() }));
    const roundTokens = estimateTokens(probe.requests[0]!.system + probe.requests[0]!.user);
    // A prior block that does not fit in the room the limit leaves for it.
    const priorBlock = `${renderExploredBlock(PRIOR_ENTRIES, [])}\n${'x'.repeat(10_000)}`;
    const { model, requests } = recordingModel([READ_GUARD_JSON, VERDICTS]);

    await runVerifyPass(verifyInput(model, {
      maxInputTokens: roundTokens + estimateTokens(JSON_ONLY_REMINDER) + 10,
      explore: explorePass({ priorBlock, priorEntries: PRIOR_ENTRIES }),
    }));

    // The prior block is not in the prompt, so the verifier shows the entry in its own block.
    expect(requests[1]!.user).not.toContain('xxxxxxxxxx');
    const markers = requests[1]!.user.match(/<<<UNTRUSTED:EXPLORED:src\/guard\.ts>>>/g) ?? [];
    expect(markers).toHaveLength(1);
  });

  it('sends the plain verification prompt when the prior block does not fit the spend', async () => {
    // The spend pays for the plain verification call and for the exploration, but not for the
    // verification call that carries the prior block.
    let checks = 0;
    const spend = {
      canAfford: () => {
        checks += 1;
        // The first check is the plain verification call, the second is the exploration's round.
        return checks <= 2;
      },
      record: () => {},
    } as unknown as SpendTracker;
    const { model, requests } = recordingModel([READ_GUARD_JSON, VERDICTS]);

    await runVerifyPass(verifyInput(model, {
      spend,
      explore: explorePass({
        priorBlock: renderExploredBlock(PRIOR_ENTRIES, []),
        priorEntries: PRIOR_ENTRIES,
      }),
    }));

    // The call went with the prompt that passed the earlier check: the blocks are not in it.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.user).not.toContain('EXPLORED:');
  });

  it('makes no verification call when the deadline expires during the verifier\'s round', async () => {
    let clock = 0;
    const deadline = new ReviewDeadline(60_000, () => clock);
    const requests: ReviewModelRequest[] = [];
    const model: ReviewModel = {
      label: 'fake:verify-deadline',
      generate: async (request) => {
        requests.push(request);
        // The round uses the time the review had left.
        clock = 120_000;
        return { text: NOTHING, finishReason: 'stop' };
      },
    };

    const result = await runVerifyPass(verifyInput(model, { deadline, explore: explorePass() }));

    expect(requests).toHaveLength(1);
    expect(result.incompleteReasons).toContain('verification skipped: time limit reached');
  });
});

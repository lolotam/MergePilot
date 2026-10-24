/**
 * The exploration rounds (ADR-0046): the protocol the model answers with, the rounds that stop,
 * and the block the review call carries.
 */

import { describe, expect, it } from 'vitest';
import type { ExploreLimits } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import { estimateTokens } from './budget.js';
import { ReviewDeadline } from './call.js';
import { ExploreBudget, runExploration, type RepositoryReader } from './explore.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { SpendTracker } from './spend.js';

const LIMITS: ExploreLimits = {
  maxRounds: 3,
  maxRequestsPerRound: 8,
  maxReadTokens: 30_000,
  maxLinesPerRead: 400,
};

const READ_A = JSON.stringify({ explore: [{ read: { path: 'src/a.ts' } }] });
const READ_A_NULL_LINES = JSON.stringify({
  explore: [{ read: { path: 'src/a.ts', startLine: null, endLine: null } }],
});
const READ_B = JSON.stringify({ explore: [{ read: { path: 'src/b.ts' } }] });
const NOTHING = JSON.stringify({ explore: [] });

function makeModel(answers: string[]): { model: ReviewModel; requests: ReviewModelRequest[] } {
  const requests: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'fake:explore',
    generate: async (request) => {
      requests.push(request);
      return {
        text: answers.shift() ?? NOTHING,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  return { model, requests };
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

function options(overrides: Partial<Parameters<typeof runExploration>[0]> = {}): Parameters<typeof runExploration>[0] {
  return {
    model: makeModel([NOTHING]).model,
    spend: new SpendTracker(undefined, 0.5),
    deadline: new ReviewDeadline(60_000),
    system: 'SYSTEM',
    user: 'USER',
    rounds: 3,
    limits: LIMITS,
    budget: new ExploreBudget(LIMITS),
    reader: fakeReader(),
    heldTexts: { texts: new Map(), patches: new Set() },
    allowPath: () => true,
    knownSecrets: [],
    purpose: 'review',
    reserve: { promptTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

describe('the exploration rounds (ADR-0046)', () => {
  it('runs the rounds the model asks for and stops on an empty list', async () => {
    const { model, requests } = makeModel([READ_A, READ_B, NOTHING]);
    const budget = new ExploreBudget(LIMITS);

    const result = await runExploration(options({
      model,
      budget,
      reader: fakeReader({ 'src/a.ts': 'const a = 1;', 'src/b.ts': 'const b = 2;' }),
    }));

    expect(requests).toHaveLength(3);
    expect(result.block).toContain('src/a.ts');
    expect(result.block).toContain('src/b.ts');
    expect(budget.rounds).toBe(3);
    expect(budget.requests).toBe(2);
    expect(budget.filesRead).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('caps the rounds at the configured limit', async () => {
    const { model, requests } = makeModel([READ_A, READ_A, READ_A, READ_A]);

    await runExploration(options({ model, rounds: 2, reader: fakeReader({ 'src/a.ts': 'const a = 1;' }) }));

    expect(requests).toHaveLength(2);
  });

  it('ends the exploration when the answer is not the protocol', async () => {
    const { model, requests } = makeModel(['I would like to look at the guard.', READ_A]);

    const result = await runExploration(options({ model, reader: fakeReader({ 'src/a.ts': 'const a = 1;' }) }));

    expect(requests).toHaveLength(1);
    expect(result.block).toBe('');
  });

  it('ends the exploration when the call fails, without failing the review', async () => {
    const model: ReviewModel = {
      label: 'fake:explore-fail',
      generate: async () => {
        throw new Error('provider is down');
      },
    };
    const budget = new ExploreBudget(LIMITS);

    const result = await runExploration(options({ model, budget }));

    expect(result.block).toBe('');
    expect(budget.rounds).toBe(0);
    expect(budget.disclosure().skipped).toContain('provider is down');
  });

  it('runs no round when the deadline has passed', async () => {
    const { model, requests } = makeModel([READ_A]);

    const result = await runExploration(options({ model, deadline: new ReviewDeadline(0) }));

    expect(requests).toHaveLength(0);
    expect(result.block).toBe('');
  });

  it('runs no round when the prompt is over the input-token limit', async () => {
    // The prompt of the first round, measured without a limit.
    const probe = makeModel([NOTHING]);
    await runExploration(options({ model: probe.model }));
    const roundTokens = estimateTokens(probe.requests[0]!.system + probe.requests[0]!.user);
    const { model, requests } = makeModel([NOTHING]);
    const budget = new ExploreBudget(LIMITS);

    const result = await runExploration(options({ model, budget, promptLimit: roundTokens - 1 }));

    expect(requests).toHaveLength(0);
    expect(result.block).toBe('');
    expect(budget.disclosure().skipped).toBe('exploration prompt over the input-token limit');
  });

  it('runs no round when the spend cannot afford the call', async () => {
    const { model, requests } = makeModel([READ_A]);
    const spend = new SpendTracker(
      { inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 1000, cacheWritePerMTok: 1000 },
      0.000001,
    );

    const result = await runExploration(options({ model, spend }));

    expect(requests).toHaveLength(0);
    expect(result.block).toBe('');
  });

  it('runs no round when the spend cannot pay for the reserved call too', async () => {
    const { model, requests } = makeModel([NOTHING]);
    const spend = new SpendTracker(
      { inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 1000, cacheWritePerMTok: 1000 },
      100,
    );

    const result = await runExploration(options({
      model,
      spend,
      // The money the review call needs is out of the exploration's reach.
      reserve: { promptTokens: 1_000_000, outputTokens: 0 },
    }));

    expect(requests).toHaveLength(0);
    expect(result.block).toBe('');
  });

  it('runs a round when the spend pays for the reserved call too', async () => {
    const { model, requests } = makeModel([NOTHING]);
    const spend = new SpendTracker(
      { inputPerMTok: 1000, outputPerMTok: 1000, cacheReadPerMTok: 1000, cacheWritePerMTok: 1000 },
      100,
    );

    await runExploration(options({ model, spend, reserve: { promptTokens: 0, outputTokens: 0 } }));

    expect(requests).toHaveLength(1);
  });

  it('reserves the results of the earlier rounds for the call that follows', async () => {
    const file = { 'src/a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;' };
    // The block the first round produced: the call that follows carries it again in its prompt.
    const learned = await runExploration(options({
      model: makeModel([READ_A, NOTHING]).model,
      budget: new ExploreBudget(LIMITS),
      reader: fakeReader(file),
    }));
    const blockTokens = estimateTokens(learned.block);
    const { model, requests } = makeModel([READ_A, READ_A]);
    const reserved: number[] = [];
    const spend = {
      canAfford: (promptTokens: number) => {
        const growth = promptTokens - (reserved[0] ?? promptTokens);
        reserved.push(promptTokens);
        // The first round fits; the next one reserves the results of the first one too, so the
        // reserved total grows by the block: the round is refused.
        return reserved.length === 1 || growth < blockTokens;
      },
      record: () => {},
    } as unknown as SpendTracker;

    await runExploration(options({ model, spend, reader: fakeReader(file) }));

    expect(requests).toHaveLength(1);
    expect(reserved).toHaveLength(2);
  });

  it('never fails the review when the reader fails', async () => {
    const { model } = makeModel([READ_A, NOTHING]);
    const reader: RepositoryReader = {
      async readFile() {
        throw new Error('the provider is down');
      },
      async listDirectory() {
        throw new Error('the provider is down');
      },
      async listPaths() {
        throw new Error('the provider is down');
      },
    };

    const result = await runExploration(options({ model, reader }));

    expect(result.block).toContain('read failed');
    expect(result.block).not.toContain('the provider is down');
  });

  it('combines the usage of every call', async () => {
    const { model } = makeModel([READ_A, NOTHING]);

    const result = await runExploration(options({ model, reader: fakeReader({ 'src/a.ts': 'const a = 1;' }) }));

    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('shows the read content in the block, escaped and redacted', async () => {
    const secret = new Secret('workspace-explore-secret-42');
    const { model } = makeModel([READ_A, NOTHING]);
    const reader = fakeReader({
      'src/a.ts': `const marker = '<<<UNTRUSTED:PATCH:x>>>';\nconst key = '${secret.reveal()}';`,
    });

    const result = await runExploration(options({
      model,
      reader,
      knownSecrets: [secret],
    }));

    expect(result.block.startsWith('EXPLORED (read-only files and searches you asked for')).toBe(true);
    expect(result.block).toContain('‹‹‹UNTRUSTED:PATCH:x›››');
    expect(result.block).not.toContain('<<<UNTRUSTED:PATCH:x>>>');
    expect(result.block).toContain('[REDACTED:known]');
    expect(result.block).not.toContain(secret.reveal());
  });

  it('tells the model what it may ask for', async () => {
    const { model, requests } = makeModel([NOTHING]);

    await runExploration(options({ model, purpose: 'verify' }));

    expect(requests[0]!.system).toContain('EXPLORATION (round 1 of 3)');
    expect(requests[0]!.system).toContain('about to judge the findings');
    expect(requests[0]!.system).toContain('"explore"');
  });

  it('reads the whole file when the answer sends null lines', async () => {
    const { model } = makeModel([READ_A_NULL_LINES, NOTHING]);
    const reader = fakeReader({ 'src/a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;' });

    const result = await runExploration(options({ model, reader }));

    expect(result.block).toContain('1| const a = 1;');
    expect(result.block).toContain('3| const c = 3;');
  });

  it('runs the valid requests of an answer that holds an invalid one', async () => {
    const answer = JSON.stringify({
      explore: [{ read: { path: 42 } }, { read: { path: 'src/a.ts' } }],
    });
    const { model } = makeModel([answer, NOTHING]);
    const budget = new ExploreBudget(LIMITS);

    const result = await runExploration(options({
      model,
      budget,
      reader: fakeReader({ 'src/a.ts': 'const a = 1;' }),
    }));

    expect(result.block).toContain('src/a.ts');
    expect(budget.requests).toBe(1);
  });

  it('runs at most the requests one round allows', async () => {
    const asked = Array.from({ length: 25 }, (_, index) => ({ read: { path: `src/file${index}.ts` } }));
    const { model } = makeModel([JSON.stringify({ explore: asked }), NOTHING]);
    const files = Object.fromEntries(
      asked.map((_, index) => [`src/file${index}.ts`, `const value${index} = ${index};`]),
    );
    const budget = new ExploreBudget(LIMITS);

    await runExploration(options({ model, budget, reader: fakeReader(files) }));

    expect(budget.requests).toBe(LIMITS.maxRequestsPerRound);
  });

  it('redacts and flattens the label of a result', async () => {
    const secret = new Secret('workspace-explore-secret-42');
    const answer = JSON.stringify({ explore: [{ find: { text: `${secret.reveal()}\nsecond line` } }] });
    const { model } = makeModel([answer, NOTHING]);

    const result = await runExploration(options({ model, knownSecrets: [secret] }));

    expect(result.block).toContain('<<<UNTRUSTED:EXPLORED:find: [REDACTED:known] second line>>>');
    expect(result.block).not.toContain(secret.reveal());
  });

  it('shows an identical read once, even when the round asks for it twice', async () => {
    const answer = JSON.stringify({
      explore: [{ read: { path: 'src/a.ts' } }, { read: { path: 'src/a.ts' } }],
    });
    const { model } = makeModel([answer, NOTHING]);
    const budget = new ExploreBudget(LIMITS);

    const result = await runExploration(options({
      model,
      budget,
      reader: fakeReader({ 'src/a.ts': 'const a = 1;' }),
    }));

    const markers = result.block.match(/<<<UNTRUSTED:EXPLORED:src\/a\.ts>>>/g) ?? [];

    expect(markers).toHaveLength(1);
    expect(budget.requests).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { estimateTokens } from './budget.js';
import { ReviewDeadline } from './call.js';
import { exploreBeforeSinglePass } from './explore-step.js';
import type { RepositoryReader } from './explore.js';
import type { ReviewModel } from './model.js';
import { SpendTracker } from './spend.js';

const reader: RepositoryReader = {
  async readFile(path) {
    return path === 'src/guard.ts' ? 'export function guard() {}' : null;
  },
  async listDirectory() {
    return null;
  },
  async listPaths() {
    return null;
  },
};

describe('the exploration step budget recheck (issue #183)', () => {
  it('leaves explored results out when the paid review prompt no longer fits', async () => {
    const answers = [
      JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] }),
      JSON.stringify({ explore: [] }),
    ];
    const model: ReviewModel = {
      label: 'fake:explore-budget',
      generate: async () => ({ text: answers.shift() ?? '', finishReason: 'stop' }),
    };
    // Exploration and its reserves fit; the final review prompt at the new paid price does not.
    let required = false;
    const spend = {
      canAfford: (_promptTokens: number, outputTokens: number) => outputTokens !== 4096,
      record: () => {},
      requireAffordableNext: () => { required = true; },
    } as unknown as SpendTracker;
    const prompt = { system: 'system', user: 'plain review prompt' };

    const result = await exploreBeforeSinglePass({
      explore: { reader },
      review: { exclude: [] },
      batched: false,
      model,
      spend,
      deadline: new ReviewDeadline(60_000),
      prompt,
      promptTokens: estimateTokens(prompt.system + prompt.user),
      promptLimit: 100_000,
      files: [],
      contextFiles: [],
      knownSecrets: [],
      reviewOutputTokens: 4096,
    });

    expect(required).toBe(true);
    expect(result.prompt).toEqual(prompt);
    expect(result.prompt.user).not.toContain('EXPLORED (');
    expect(result.disclosure().exploration).toMatchObject({
      skipped: 'explored results left out: budget limit reached',
    });
  });

  it('requires the review affordability check when an exploration call fails before a round', async () => {
    const spend = new SpendTracker(
      { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 1, cacheWritePerMTok: 1 },
      5,
    );
    const model: ReviewModel = {
      label: 'fake:explore-timeout',
      generate: async () => { throw new Error('TIMEOUT'); },
    };
    const prompt = { system: 'system', user: 'plain review prompt' };

    await exploreBeforeSinglePass({
      explore: { reader },
      review: { exclude: [] },
      batched: false,
      model,
      spend,
      deadline: new ReviewDeadline(60_000),
      prompt,
      promptTokens: estimateTokens(prompt.system + prompt.user),
      promptLimit: 100_000,
      files: [],
      contextFiles: [],
      knownSecrets: [],
      reviewOutputTokens: 4096,
    });

    expect(spend.spentUsd).toBeGreaterThan(0);
    expect(spend.mustCheckNext).toBe(true);
  });
});

it('retains a trimmed explored result when it overflows the input limit (B23)', async () => {
  const prompt = { system: 'review system', user: 'patch '.repeat(100) };
  const result = await exploreBeforeSinglePass({
    explore: { reader: { ...reader, readFile: async () => 'evidence '.repeat(500) } },
    review: { exclude: [], explore: { maxRounds: 1 } }, batched: false,
    model: { label: 'fake:overflow', generate: async () => ({ text: JSON.stringify({ explore: [{ read: { path: 'src/guard.ts' } }] }), finishReason: 'stop' }) },
    spend: new SpendTracker(undefined, 1), deadline: new ReviewDeadline(60000),
    prompt, promptTokens: estimateTokens(prompt.system + prompt.user), promptLimit: 1000,
    files: [], contextFiles: [], knownSecrets: [], reviewOutputTokens: 4096,
  });
  expect(result.prompt.user).toContain('EXPLORED:src/guard.ts');
  expect(result.prompt.user).toContain('evidence');
  expect(result.prompt.user).toContain('[explored result truncated');
  expect(result.promptTokens).toBeLessThanOrEqual(1000);
  expect(result.disclosure().exploration?.skipped).toBe('explored results trimmed to fit the input-token limit');
});

it('redacts known secrets in disclosed read paths before notes can display them', async () => {
  const secret = new Secret('b23-private-token');
  const path = `src/${secret.reveal()}.ts`;
  const prompt = { system: 'system', user: 'patch' };
  const result = await exploreBeforeSinglePass({
    explore: { reader: { ...reader, readFile: async () => 'safe content' } },
    review: { exclude: [], explore: { maxRounds: 1 } }, batched: false,
    model: { label: 'fake:path', generate: async () => ({ text: JSON.stringify({ explore: [{ read: { path } }] }), finishReason: 'stop' }) },
    spend: new SpendTracker(undefined, 1), deadline: new ReviewDeadline(60000),
    prompt, promptTokens: estimateTokens(prompt.system + prompt.user), promptLimit: 10000,
    files: [], contextFiles: [], knownSecrets: [secret], reviewOutputTokens: 4096,
  });
  expect(JSON.stringify(result.disclosure())).not.toContain(secret.reveal());
  expect(result.disclosure().exploration?.filesRead).toEqual(['src/[REDACTED:known].ts']);
});

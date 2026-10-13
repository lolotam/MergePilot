import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { runReview } from './pipeline.js';

// Output-only pricing keeps the arithmetic exact: $10 per 1M output tokens.
const PRICING = { inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function pricedConfig(perReviewUsd: number, verify = false): MergePilotConfig {
  const base = makeConfig();
  return makeConfig({
    review: { ...base.review, verify },
    budget: { perReviewUsd, maxInputTokens: 200000, pricing: PRICING },
  });
}

function scriptedModel(
  answers: Array<(req: ReviewModelRequest) => ReviewModelResponse>,
  outputTokensFor: (max: number) => number = (max) => max,
): { model: ReviewModel; calls: ReviewModelRequest[] } {
  const calls: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'fake:scripted',
    outputTokensFor,
    generate: async (req) => {
      calls.push(req);
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error(`unexpected call ${calls.length}`);
      return answer(req);
    },
  };
  return { model, calls };
}

const twoFiles = [
  { path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 },
  { path: 'src/b.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 },
];

describe('runReview — spend across retries and batches (ADR-0011)', () => {
  it('charges usage-less calls at their estimate, so retries and batches never exceed perReviewUsd', async () => {
    // Every call reports zero usage (some compatible streams). Main call ~ $0.04096.
    // Retry (8192) would make it $0.12288 > $0.10 → skipped. Batch 1 fits ($0.08192), batch 2 does not.
    const { model, calls } = scriptedModel([
      () => ({ text: '{"summary": "cut', finishReason: 'max-tokens', usage: ZERO_USAGE }),
      () => ({
        text: JSON.stringify({ summary: 'Batch A.', findings: [validFindingJson({ path: 'src/a.ts', line: 2 })] }),
        finishReason: 'stop',
        usage: ZERO_USAGE,
      }),
    ]);

    const result = await runReview({
      config: pricedConfig(0.1),
      pr: { title: 'T', body: 'B' },
      files: twoFiles,
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(calls.map((c) => c.maxOutputTokens)).toEqual([4096, 4096]);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain('truncation retry skipped: budget limit reached');
      expect(result.result.incompleteReasons).toContain('batch 2 (src/b.ts): budget limit reached');
      expect(result.costUsd).toBeLessThanOrEqual(0.1);
    }
  });

  it('prices the retry with the thinking headroom the model really requests', async () => {
    // Main: 4096 + 8192 headroom = 12288 → $0.12288. Retry without headroom ($0.08192) would fit
    // under $0.25; with headroom (16384 + 8192 → $0.24576) it does not.
    const { model, calls } = scriptedModel(
      [() => ({ text: '{"summary": "cut', finishReason: 'max-tokens' })],
      (max) => max + 8192,
    );
    const result = await runReview({
      config: pricedConfig(0.25),
      pr: { title: 'T', body: 'B' },
      files: [twoFiles[0]!],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toMatch(/^truncated/);
      expect(result.detail).toContain('truncation retry skipped: budget limit reached');
    }
  });

  it('stop + broken JSON is asked once more for JSON only, then fails as invalid-json without batching', async () => {
    const broken = (): ReviewModelResponse => ({ text: '{"summary": "x", "findings": [', finishReason: 'stop' });
    const { model, calls } = scriptedModel([broken, broken]);
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: twoFiles,
      rulesFiles: [],
      model,
      knownSecrets: [],
    });
    expect(calls).toHaveLength(2);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toMatch(/^invalid-json.*\(also after asking for JSON only\)/);
  });
});

describe('runReview — verification retry is budget-gated', () => {
  const verifyCut = (): ReviewModelResponse => ({ text: '{"verdicts": [', finishReason: 'max-tokens' });

  it('skips the verify retry with a disclosed reason when it does not fit the budget', async () => {
    // Review 4096 + verify 2048 = $0.06144 preflight; retry 4096 would reach $0.1024 > $0.10.
    const { model, calls } = scriptedModel([
      () => ({ text: makeAnswerJson(), finishReason: 'stop' }),
      verifyCut,
    ]);
    const result = await runReview({
      config: pricedConfig(0.1, true),
      pr: { title: 'T', body: 'B' },
      files: [twoFiles[0]!],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });
    expect(calls).toHaveLength(2);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      const reasons = result.result.incompleteReasons;
      expect(reasons).toContain('verification retry skipped: budget limit reached');
      expect(reasons.some((r) => r.startsWith('verification skipped: truncated'))).toBe(true);
      expect(result.costUsd).toBeLessThanOrEqual(0.1);
    }
  });

  it('records a failed verify retry instead of swallowing it', async () => {
    const { model, calls } = scriptedModel([
      () => ({ text: makeAnswerJson(), finishReason: 'stop' }),
      verifyCut,
      () => {
        throw Object.assign(new Error('boom'), { code: 'server-error' });
      },
    ]);
    const result = await runReview({
      config: pricedConfig(0.5, true),
      pr: { title: 'T', body: 'B' },
      files: [twoFiles[0]!],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([4096, 2048, 4096]);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result.incompleteReasons).toContain('verification retry failed: server-error');
    }
  });
});

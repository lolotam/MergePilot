import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { LlmFailure } from '../llm/failure.js';
import type { ReviewModel, ReviewModelResponse } from './model.js';
import { makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview, type ReviewRunResult } from './pipeline.js';

// A review that fails after paid calls keeps their spend (ADR-0027 amendment). Output-only
// pricing keeps the arithmetic exact: 1000 output tokens at $10 per 1M is $0.01 per call.
const PRICING = { inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
const USAGE = { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const LABEL = 'openai:gpt-5';

/** Two broken answers: the answer and the JSON-only retry, then the review fails as invalid-json. */
const brokenAnswer = async (): Promise<ReviewModelResponse> => ({
  text: '{"summary": "x", "findings": [',
  finishReason: 'stop',
  usage: USAGE,
});
const quota = async (): Promise<never> => {
  throw new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'QUOTA from openai' });
};

function pricedConfig(): MergePilotConfig {
  return makeConfig({ budget: { perReviewUsd: 1, maxInputTokens: 200000, pricing: PRICING } });
}

async function failedReview(model: ReviewModel, fallbackModels?: ReviewModel[]): Promise<Extract<ReviewRunResult, { status: 'failed' }>> {
  const result = await runReview({
    config: pricedConfig(),
    pr: { title: 'T', body: 'B' },
    files: [{ path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model,
    ...(fallbackModels ? { fallbackModels } : {}),
    knownSecrets: [],
  });
  if (result.status !== 'failed') throw new Error(`expected a failed review, got ${result.status}`);
  return result;
}

describe('runReview — a failed review keeps its spend (ADR-0027 amendment)', () => {
  it('records the cost and tokens of the paid calls made before the failure', async () => {
    const result = await failedReview({ label: LABEL, generate: brokenAnswer });

    expect(result.reason).toMatch(/^invalid-json/);
    expect(result.costUsd).toBeCloseTo(0.02, 12);
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 2000 });
    expect(result.onlySubscriptionCalls).toBe(false);
  });

  it('costs $0 when every call was on a subscription', async () => {
    const result = await failedReview({ label: LABEL, authMethod: 'subscription', includedInSubscription: true, generate: brokenAnswer });

    expect(result.costUsd).toBe(0);
    expect(result.onlySubscriptionCalls).toBe(true);
    expect(result.usage).toMatchObject({ outputTokens: 2000 });
  });

  it('keeps the cost known after a method-only fallback to paid API keys', async () => {
    const keys: ReviewModel = { label: LABEL, authMethod: 'api-key', fallbackTriggers: ['quota', 'rate-limit'], generate: brokenAnswer };
    const result = await failedReview({ label: LABEL, authMethod: 'subscription', includedInSubscription: true, generate: quota }, [keys]);

    expect(result).toMatchObject({ fallbackFrom: LABEL, modelUsed: LABEL, fallbackFromMethod: 'subscription', modelUsedMethod: 'api-key' });
    expect(result.costUsd).toBeCloseTo(0.02, 12);
    expect(result.onlySubscriptionCalls).toBe(false);
  });

  it('leaves the cost unknown after a configured model fallback, with its tokens', async () => {
    const other: ReviewModel = { label: 'anthropic:claude', generate: brokenAnswer };
    const result = await failedReview({ label: LABEL, generate: quota }, [other]);

    expect(result).toMatchObject({ fallbackFrom: LABEL, modelUsed: 'anthropic:claude' });
    expect(result.costUsd).toBeUndefined();
    expect(result.usage).toMatchObject({ outputTokens: 2000 });
  });
});

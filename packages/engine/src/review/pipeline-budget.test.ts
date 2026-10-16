import { describe, expect, it, vi } from 'vitest';
import { modelFromAdapter, type ReviewModel } from './model.js';
import {
  makeAnswerJson,
  makeConfig,
  makeModel,
  SIMPLE_PATCH,
} from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';
import { LlmFailure } from '../llm/failure.js';
import { Secret } from '../credentials/secret.js';
import { AnthropicAdapter } from '../providers/anthropic/adapter.js';

describe('runReview - USD budget and pricing', () => {
  it('reports zero cost when one subscription falls back to another subscription', async () => {
    const primary: ReviewModel = { label: 'openai:subscription', includedInSubscription: true,
      generate: async () => { throw new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'Quota reached' }); } };
    const fallback = { ...makeModel(makeAnswerJson()), label: 'xai:subscription', includedInSubscription: true };
    const result = await runReview({ config: makeConfig(), pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }], rulesFiles: [],
      model: primary, fallbackModels: [fallback], knownSecrets: [] });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.costUsd).toBe(0);
      expect(result.fallbackFrom).toBe(primary.label);
      expect(result.modelUsed).toBe(fallback.label);
    }
  });

  it('keeps paid API fallback cost unknown and charges its calls against the spend limit', async () => {
    const primary: ReviewModel = { label: 'openai:subscription', includedInSubscription: true,
      generate: async () => { throw new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'Quota reached' }); } };
    // A truncated paid fallback spends more than the cap: no free truncation retry is allowed.
    const generate = vi.fn(async () => ({ text: '{"summary":"truncated', finishReason: 'max-tokens' as const,
      usage: { inputTokens: 100000, outputTokens: 4096, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    const config = makeConfig({ budget: { perReviewUsd: 0.01, maxInputTokens: 200000,
      pricing: { inputPerMTok: 5, outputPerMTok: 15, cacheReadPerMTok: 5, cacheWritePerMTok: 5 } } });
    config.review.verify = false;
    const result = await runReview({ config,
      pr: { title: 'T', body: 'B' }, files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [], model: primary, fallbackModels: [{ label: 'anthropic:api', generate }], knownSecrets: [] });
    expect(generate).toHaveBeenCalledTimes(1);
    if (result.status === 'completed') expect(result.costUsd).toBeUndefined();
    else expect(result.status).toBe('failed');
  });
  it('records zero incremental cost for a subscription even when API prices would exceed the budget', async () => {
    const model = { ...makeModel(makeAnswerJson(), { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }), includedInSubscription: true };
    const result = await runReview({
      config: makeConfig({ budget: { perReviewUsd: 0.0001, maxInputTokens: 200000,
        pricing: { inputPerMTok: 100, outputPerMTok: 100, cacheReadPerMTok: 100, cacheWritePerMTok: 100 } } }),
      pr: { title: 'T', body: 'B' }, files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [], model, knownSecrets: [],
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.costUsd).toBe(0);
  });
  it('rejects with skipped-budget when estimated cost exceeds perReviewUsd and never calls model', async () => {
    const generateMock = vi.fn();
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    // Prompt tokens estimate: roughly ceil(chars / 3.5).
    // With pricing inputPerMTok: 100, outputPerMTok: 100, and maxOutputTokens 4096:
    // output cost alone is 4096 * 100 / 1,000,000 = $0.4096.
    // If perReviewUsd is 0.10, estimate will exceed 0.10.
    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 0.1,
          maxInputTokens: 200000,
          pricing: {
            inputPerMTok: 100,
            outputPerMTok: 100,
            cacheReadPerMTok: 100,
            cacheWritePerMTok: 100,
          },
        },
      }),
      pr: { title: 'Big PR', body: 'Description' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('skipped-budget');
    expect(generateMock).not.toHaveBeenCalled();
    if (result.status === 'skipped-budget') {
      expect(result.reason).toMatch(/estimated \$[0-9.]+ > limit \$0\.10/);
    }
  });

  it('prices an adaptive Claude review at its full thinking headroom before calling it', async () => {
    const stream = vi.fn();
    const adapter = new AnthropicAdapter({ apiKey: new Secret('sk-test-000'), client: { messages: { stream } } });
    // Output alone: (4096 answer + 32768 high-effort headroom) x $25/MTok = $0.92 > $0.80.
    // The old 16384 headroom priced it at $0.51 and let the call through.
    const config = makeConfig({ budget: { perReviewUsd: 0.8, maxInputTokens: 200000,
      pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 } } });
    config.review.verify = false;

    const result = await runReview({ config, pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }], rulesFiles: [],
      model: modelFromAdapter(adapter, 'claude-opus-5-5', 'high'), knownSecrets: [] });

    expect(result.status).toBe('skipped-budget');
    if (result.status === 'skipped-budget') expect(result.reason).toMatch(/estimated \$0\.9\d* > limit \$0\.80/);
    expect(stream).not.toHaveBeenCalled();
  });

  it('passes USD gate when estimated cost is under perReviewUsd and calls model', async () => {
    const generateMock = vi.fn().mockResolvedValue({
      text: makeAnswerJson(),
      finishReason: 'stop',
    });
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 10.0,
          maxInputTokens: 200000,
          pricing: {
            inputPerMTok: 1.0,
            outputPerMTok: 2.0,
            cacheReadPerMTok: 1.0,
            cacheWritePerMTok: 1.0,
          },
        },
      }),
      pr: { title: 'Normal PR', body: 'Description' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    expect(generateMock).toHaveBeenCalled();
  });

  it('computes costUsd from actual usage when model returns usage', async () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 2_000,
    };
    const model = makeModel(makeAnswerJson(), usage);

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 5.0,
          maxInputTokens: 200000,
          pricing: {
            inputPerMTok: 3.0,
            outputPerMTok: 15.0,
            cacheReadPerMTok: 0.3,
            cacheWritePerMTok: 3.75,
          },
        },
      }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      // Math:
      // (10,000 * 3 + 1,000 * 15 + 5,000 * 0.3 + 2,000 * 3.75) / 1,000,000
      // = (30,000 + 15,000 + 1,500 + 7,500) / 1,000,000 = 54,000 / 1,000,000 = 0.054
      expect(result.costUsd).toBe(0.054);
    }
  });

  it('computes costUsd from estimate when model returns no usage', async () => {
    const model = makeModel(makeAnswerJson()); // no usage provided

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 5.0,
          maxInputTokens: 200000,
          pricing: {
            inputPerMTok: 3.0,
            outputPerMTok: 15.0,
            cacheReadPerMTok: 3.0,
            cacheWritePerMTok: 3.0,
          },
        },
      }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(typeof result.costUsd).toBe('number');
      expect(result.costUsd).toBeGreaterThan(0);
    }
  });

  it('does not apply USD gate and does not set costUsd when pricing is absent', async () => {
    const generateMock = vi.fn().mockResolvedValue({
      text: makeAnswerJson(),
      finishReason: 'stop',
    });
    const model: ReviewModel = {
      label: 'fake:spy',
      generate: generateMock,
    };

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 0.00001, // extremely low, but no pricing!
          maxInputTokens: 200000,
        },
      }),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    expect(generateMock).toHaveBeenCalled();
    if (result.status === 'completed') {
      expect(result.costUsd).toBeUndefined();
    }
  });

  it('counts the verification call in the pre-call USD estimate', async () => {
    const generateMock = vi.fn();
    const model: ReviewModel = { label: 'fake:spy', generate: generateMock };
    const budget = {
      // Review call alone ≈ $0.45–0.49 at $100/MTok; with verification ≈ $0.69–0.78.
      perReviewUsd: 0.6,
      maxInputTokens: 200000,
      pricing: { inputPerMTok: 100, outputPerMTok: 100 },
    };
    const input = (verify: boolean) => ({
      config: makeConfig({ review: { ...makeConfig().review, verify }, budget }),
      pr: { title: 'PR', body: '' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model,
      knownSecrets: [],
    });

    const withVerify = await runReview(input(true));
    expect(withVerify.status).toBe('skipped-budget');
    expect(generateMock).not.toHaveBeenCalled();

    generateMock.mockResolvedValue({ text: makeAnswerJson([]), finishReason: 'stop' });
    const withoutVerify = await runReview(input(false));
    expect(withoutVerify.status).toBe('completed');
  });
});

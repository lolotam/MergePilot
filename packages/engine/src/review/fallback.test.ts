import { Secret } from '../credentials/secret.js';
import { describe, expect, it } from 'vitest';
import { LlmFailure } from '../llm/failure.js';
import { FallbackChain, FALLBACK_TRIGGERS, failureKindOf } from './fallback.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

function mockModel(label: string, reply: string = 'ok'): ReviewModel & { calls: number } {
  let calls = 0;
  return {
    label,
    get calls() {
      return calls;
    },
    generate: async (): Promise<ReviewModelResponse> => {
      calls++;
      return { text: reply, finishReason: 'stop' };
    },
  };
}

function subscriptionModel(label: string, usage: { inputTokens: number; outputTokens: number }): ReviewModel {
  return {
    label,
    includedInSubscription: true,
    generate: async (): Promise<ReviewModelResponse> => ({ text: 'ok', finishReason: 'stop', usage }),
  };
}

function failingModel(label: string, failure: unknown): ReviewModel & { calls: number } {
  let calls = 0;
  return {
    label,
    get calls() {
      return calls;
    },
    generate: async (): Promise<ReviewModelResponse> => {
      calls++;
      throw failure;
    },
  };
}

const req: ReviewModelRequest = {
  system: 'sys',
  user: 'user',
  maxOutputTokens: 100,
};

describe('FallbackChain', () => {
  it('defines the correct trigger failure kinds', () => {
    expect([...FALLBACK_TRIGGERS].sort()).toEqual(['auth', 'network', 'quota', 'rate-limit', 'server'].sort());
  });

  describe('failureKindOf', () => {
    it('categorizes LlmFailure codes correctly', () => {
      expect(failureKindOf(new LlmFailure({ code: 'QUOTA', provider: 'p', message: 'm' }))).toBe('quota');
      expect(failureKindOf(new LlmFailure({ code: 'RATE_LIMIT', provider: 'p', message: 'm' }))).toBe('rate-limit');
      expect(failureKindOf(new LlmFailure({ code: 'SERVER', provider: 'p', message: 'm' }))).toBe('server');
      expect(failureKindOf(new LlmFailure({ code: 'TIMEOUT', provider: 'p', message: 'm' }))).toBe('network');
      expect(failureKindOf(new LlmFailure({ code: 'NETWORK', provider: 'p', message: 'm' }))).toBe('network');
      expect(failureKindOf(new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'p', message: 'm' }))).toBe('auth');
      expect(failureKindOf(new LlmFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', provider: 'p', message: 'm' }))).toBe('other');
      expect(failureKindOf(new LlmFailure({ code: 'BAD_REQUEST', provider: 'p', message: 'm' }))).toBe('other');
      expect(failureKindOf(new LlmFailure({ code: 'ABORTED', provider: 'p', message: 'm' }))).toBe('other');
      expect(failureKindOf(new Error('regular error'))).toBeUndefined();
      expect(failureKindOf(null)).toBeUndefined();
      expect(failureKindOf('error')).toBeUndefined();
    });
  });

  describe('single model (no fallback configured)', () => {
    it('uses primary model and reports no fallback', async () => {
      const primary = mockModel('openai:gpt-5', 'Hello');
      const chain = new FallbackChain(primary);

      expect(chain.label).toBe('openai:gpt-5');
      const res = await chain.generate(req);
      expect(res.text).toBe('Hello');
      expect(primary.calls).toBe(1);
      expect(chain.disclosure([])).toEqual({
        modelUsed: 'openai:gpt-5',
      });
    });

    it('throws immediately when primary fails without fallbacks', async () => {
      const primary = failingModel(
        'openai:gpt-5',
        new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'No credits' }),
      );
      const chain = new FallbackChain(primary);

      await expect(chain.generate(req)).rejects.toMatchObject({ code: 'QUOTA' });
      expect(primary.calls).toBe(1);
    });
  });

  describe('with configured fallback chain', () => {
    it('switches to fallback on trigger failure and discloses the switch', async () => {
      const primary = failingModel(
        'openai:gpt-5',
        new LlmFailure({ code: 'RATE_LIMIT', provider: 'openai', message: 'Too many requests' }),
      );
      const fallback = mockModel('xai:grok-4', 'Fallback answer');
      const chain = new FallbackChain(primary, [fallback]);

      const res = await chain.generate(req);
      expect(res.text).toBe('Fallback answer');
      expect(primary.calls).toBe(1);
      expect(fallback.calls).toBe(1);
      expect(chain.label).toBe('xai:grok-4');
      expect(chain.disclosure([])).toEqual({
        modelUsed: 'xai:grok-4',
        fallbackFrom: 'openai:gpt-5',
        fallbackCode: 'rate-limit',
        fallbackDetail: 'Too many requests',
      });
    });

    it('stays on the fallback model for subsequent calls in the review', async () => {
      const primary = failingModel(
        'openai:gpt-5',
        new LlmFailure({ code: 'SERVER', provider: 'openai', message: '500 error' }),
      );
      const fallback = mockModel('openrouter:gpt-5', 'Answer');
      const chain = new FallbackChain(primary, [fallback]);

      await chain.generate(req);
      expect(primary.calls).toBe(1);
      expect(fallback.calls).toBe(1);

      // Second call in same review (e.g. verify pass)
      await chain.generate(req);
      expect(primary.calls).toBe(1); // Primary is NOT called again
      expect(fallback.calls).toBe(2);
    });

    it('tries fallbacks in order and records first transition', async () => {
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'QUOTA', provider: 'primary', message: 'quota' }),
      );
      const fallback1 = failingModel(
        'fb1:m2',
        new LlmFailure({ code: 'SERVER', provider: 'fb1', message: 'server' }),
      );
      const fallback2 = mockModel('fb2:m3', 'Success from fb2');

      const chain = new FallbackChain(primary, [fallback1, fallback2]);
      const res = await chain.generate(req);

      expect(res.text).toBe('Success from fb2');
      expect(primary.calls).toBe(1);
      expect(fallback1.calls).toBe(1);
      expect(fallback2.calls).toBe(1);
      expect(chain.disclosure([])).toEqual({
        modelUsed: 'fb2:m3',
        fallbackFrom: 'primary:m1',
        fallbackCode: 'quota',
        fallbackDetail: 'quota',
      });
    });

    it('redacts the raw detail before collapsing whitespace or bounding it', async () => {
      // Built at run time so the source holds no literal that looks like a credential.
      const credential = ['placeholder', 'credential	with  spaces', 'for', 'tests'].join('-');
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'primary', message: `${'x'.repeat(1900)} bad key ${credential} end ${'y'.repeat(500)}` }),
      );
      const chain = new FallbackChain(primary, [mockModel('fb:m2', 'ok')]);
      await chain.generate(req);

      const detail = chain.disclosure([new Secret(credential)]).fallbackDetail ?? '';
      expect(detail).not.toContain('placeholder-credential');
      expect(detail).toContain('[REDACTED');
      expect(detail.length).toBeLessThanOrEqual(2000);
    });

    it('puts the detail on one line for the caller to cut', async () => {
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'primary', message: `HTTP 401:
  ${'x'.repeat(400)}` }),
      );
      const chain = new FallbackChain(primary, [mockModel('fb:m2', 'ok')]);
      await chain.generate(req);

      expect(chain.disclosure([]).fallbackDetail).toBe(`HTTP 401: ${'x'.repeat(400)}`);
      expect(chain.disclosure([]).fallbackCode).toBe('auth');
    });

    it('throws last error when all models in the chain fail', async () => {
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'RATE_LIMIT', provider: 'primary', message: 'rate limit' }),
      );
      const fallback1 = failingModel(
        'fb1:m2',
        new LlmFailure({ code: 'SERVER', provider: 'fb1', message: 'last server error' }),
      );

      const chain = new FallbackChain(primary, [fallback1]);
      await expect(chain.generate(req)).rejects.toMatchObject({ code: 'SERVER' });
      expect(primary.calls).toBe(1);
      expect(fallback1.calls).toBe(1);
    });

    it('sums successful subscription calls under their model label', async () => {
      const chain = new FallbackChain(subscriptionModel('openai:gpt-5', { inputTokens: 10, outputTokens: 2 }));
      await chain.generate(req);
      await chain.generate(req);

      expect(chain.disclosure([]).subscriptionUsage).toEqual([
        { label: 'openai:gpt-5', usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      ]);
    });

    it('does not count a successful API-key fallback call', async () => {
      const primary = failingModel('openai:gpt-5', new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'quota' }));
      const fallback = { ...mockModel('openai:gpt-5'), generate: async (): Promise<ReviewModelResponse> => ({
        text: 'ok', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50 },
      }) };
      const chain = new FallbackChain(primary, [fallback]);
      await chain.generate(req);

      expect(chain.disclosure([]).subscriptionUsage).toBeUndefined();
    });

    it('counts a subscription fallback model under its own label', async () => {
      const primary = failingModel('openai:gpt-5', new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'quota' }));
      const chain = new FallbackChain(primary, [subscriptionModel('anthropic:claude-x', { inputTokens: 8, outputTokens: 3 })]);
      await chain.generate(req);

      expect(chain.disclosure([]).subscriptionUsage).toEqual([
        { label: 'anthropic:claude-x', usage: { inputTokens: 8, outputTokens: 3 } },
      ]);
    });

    it('omits subscription usage when no subscription call answered', async () => {
      const chain = new FallbackChain(mockModel('openai:gpt-5'));
      await chain.generate(req);
      expect(chain.disclosure([]).subscriptionUsage).toBeUndefined();
    });

    it('never triggers fallback on aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'SERVER', provider: 'primary', message: 'server' }),
      );
      const fallback = mockModel('fb:m2');
      const chain = new FallbackChain(primary, [fallback]);

      await expect(chain.generate({ ...req, signal: controller.signal })).rejects.toThrow();
      expect(primary.calls).toBe(1);
      expect(fallback.calls).toBe(0);
    });

    it('never triggers fallback on non-trigger errors (CONTEXT_WINDOW_EXCEEDED, BAD_REQUEST, syntax)', async () => {
      const primary = failingModel(
        'primary:m1',
        new LlmFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', provider: 'primary', message: 'context' }),
      );
      const fallback = mockModel('fb:m2');
      const chain = new FallbackChain(primary, [fallback]);

      await expect(chain.generate(req)).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' });
      expect(primary.calls).toBe(1);
      expect(fallback.calls).toBe(0);
    });
  });
});

describe('runReview fallback integration', () => {
  it('executes fallback model when primary fails with RATE_LIMIT and omits primary pricing', async () => {
    const primary = failingModel(
      'openai:gpt-5',
      new LlmFailure({ code: 'RATE_LIMIT', provider: 'openai', message: 'Rate limit' }),
    );
    const fallback = mockModel('xai:grok-4', makeAnswerJson());

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 0.5,
          maxInputTokens: 200000,
          pricing: { inputPerMTok: 5, outputPerMTok: 15 },
        },
      }),
      pr: { title: 'PR title', body: 'PR body' },
      files: [{ path: 'src/main.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: primary,
      fallbackModels: [fallback],
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.summary).toBe('Looks good.');
      expect(result.modelUsed).toBe('xai:grok-4');
      expect(result.fallbackFrom).toBe('openai:gpt-5');
      expect(result.fallbackCode).toBe('rate-limit');
      // Pricing belongs to primary model; after fallback cost is unknown
      expect(result.costUsd).toBeUndefined();
    }
  });

  it('reports cost when primary succeeds without fallback', async () => {
    const primary = mockModel('openai:gpt-5', makeAnswerJson());
    const fallback = mockModel('xai:grok-4', makeAnswerJson());

    const result = await runReview({
      config: makeConfig({
        budget: {
          perReviewUsd: 0.5,
          maxInputTokens: 200000,
          pricing: { inputPerMTok: 5, outputPerMTok: 15 },
        },
      }),
      pr: { title: 'PR title', body: 'PR body' },
      files: [{ path: 'src/main.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: primary,
      fallbackModels: [fallback],
      knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.modelUsed).toBe('openai:gpt-5');
      expect(result.fallbackFrom).toBeUndefined();
      expect(result.costUsd).toBeDefined();
    }
    expect(fallback.calls).toBe(0);
  });

  it('fails without fallback on non-trigger error (CONTEXT_WINDOW_EXCEEDED)', async () => {
    const primary = failingModel(
      'openai:gpt-5',
      new LlmFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', provider: 'openai', message: 'Context limit' }),
    );
    const fallback = mockModel('xai:grok-4', makeAnswerJson());

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'PR', body: 'desc' },
      files: [{ path: 'src/main.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: primary,
      fallbackModels: [fallback],
      knownSecrets: [],
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('CONTEXT_WINDOW_EXCEEDED');
      expect(result.modelUsed).toBe('openai:gpt-5');
      expect(result.fallbackFrom).toBeUndefined();
    }
    expect(fallback.calls).toBe(0);
  });
});

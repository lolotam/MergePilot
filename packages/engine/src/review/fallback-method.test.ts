import { describe, expect, it } from 'vitest';
import { LlmFailure, type LlmFailureCode } from '../llm/failure.js';
import type { TokenUsage } from '../llm/types.js';
import { FallbackChain } from './fallback.js';
import type { ReviewAuthMethod, ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

// ADR-0027: the other auth method of a dual provider sits right behind its default and is
// entered only on quota or rate limit.
const METHOD_TRIGGERS = ['quota', 'rate-limit'] as const;
const req: ReviewModelRequest = { system: 'sys', user: 'user', maxOutputTokens: 100 };
const failure = (code: LlmFailureCode) => new LlmFailure({ code, provider: 'openai', message: `${code} from openai` });

interface Spy extends ReviewModel {
  readonly calls: number;
}

function model(
  label: string,
  method: ReviewAuthMethod | undefined,
  behaviour: { fail?: LlmFailure; reply?: string; usage?: TokenUsage },
  extra: Partial<ReviewModel> = {},
): Spy {
  let calls = 0;
  return {
    label,
    ...(method ? { authMethod: method } : {}),
    ...(method === 'subscription' ? { includedInSubscription: true } : {}),
    ...extra,
    get calls() {
      return calls;
    },
    async generate(): Promise<ReviewModelResponse> {
      calls++;
      if (behaviour.fail) throw behaviour.fail;
      return { text: behaviour.reply ?? 'ok', finishReason: 'stop', ...(behaviour.usage ? { usage: behaviour.usage } : {}) };
    },
  };
}

const subscription = (behaviour: Parameters<typeof model>[2]) => model('openai:gpt-5', 'subscription', behaviour);
const keysBehind = (behaviour: Parameters<typeof model>[2]) =>
  model('openai:gpt-5', 'api-key', behaviour, { fallbackTriggers: METHOD_TRIGGERS });

describe('FallbackChain — method fallback entries (ADR-0027)', () => {
  it.each(['INVALID_CREDENTIAL', 'SERVER', 'NETWORK'] as const)(
    'passes over the keys on %s and lets the configured fallback answer',
    async (code) => {
      const keys = keysBehind({ reply: 'paid' });
      const configured = model('xai:grok-4', 'api-key', { reply: 'configured' });
      const chain = new FallbackChain(subscription({ fail: failure(code) }), [keys, configured]);

      expect((await chain.generate(req)).text).toBe('configured');
      expect(keys.calls).toBe(0);
      expect(chain.disclosure([])).toMatchObject({ modelUsed: 'xai:grok-4', fallbackFrom: 'openai:gpt-5' });
    },
  );

  it.each(['QUOTA', 'RATE_LIMIT', 'QUOTA_EXHAUSTED_ALL_KEYS'] as const)('enters the keys on %s', async (code) => {
    const keys = keysBehind({ reply: 'paid' });
    const chain = new FallbackChain(subscription({ fail: failure(code) }), [keys]);

    expect((await chain.generate(req)).text).toBe('paid');
    expect(keys.calls).toBe(1);
  });

  it('rethrows without disclosing a fallback when no later entry accepts the failure', async () => {
    const keys = keysBehind({ reply: 'paid' });
    const chain = new FallbackChain(subscription({ fail: failure('INVALID_CREDENTIAL') }), [keys]);

    await expect(chain.generate(req)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(keys.calls).toBe(0);
    expect(chain.disclosure([]).fallbackFrom).toBeUndefined();
  });

  it('discloses both methods, and keeps the primary failure, when the same model answered on keys', async () => {
    const chain = new FallbackChain(subscription({ fail: failure('RATE_LIMIT') }), [keysBehind({ reply: 'paid' })]);
    await chain.generate(req);

    expect(chain.disclosure([])).toMatchObject({
      modelUsed: 'openai:gpt-5',
      fallbackFrom: 'openai:gpt-5',
      fallbackCode: 'rate-limit',
      fallbackFromMethod: 'subscription',
      modelUsedMethod: 'api-key',
    });
  });

  it('discloses no method switch when another model answered after the keys failed too', async () => {
    const keys = keysBehind({ fail: failure('QUOTA_EXHAUSTED_ALL_KEYS') });
    const configured = model('xai:grok-4', 'api-key', { reply: 'configured' });
    const chain = new FallbackChain(subscription({ fail: failure('QUOTA') }), [keys, configured]);
    await chain.generate(req);

    const disclosure = chain.disclosure([]);
    expect(disclosure).toMatchObject({ modelUsed: 'xai:grok-4', fallbackFrom: 'openai:gpt-5', fallbackCode: 'quota' });
    expect(disclosure.fallbackFromMethod).toBeUndefined();
    expect(disclosure.modelUsedMethod).toBeUndefined();
  });

  it('discloses no method switch when both entries use the same method', async () => {
    const sameModelAgain = model('openai:gpt-5', 'api-key', { reply: 'again' });
    const chain = new FallbackChain(model('openai:gpt-5', 'api-key', { fail: failure('SERVER') }), [sameModelAgain]);
    await chain.generate(req);

    const disclosure = chain.disclosure([]);
    expect(disclosure.fallbackFrom).toBe('openai:gpt-5');
    expect(disclosure.fallbackFromMethod).toBeUndefined();
  });

  it('skips an entry the budget hook refuses', async () => {
    const keys = keysBehind({ reply: 'paid' });
    const chain = new FallbackChain(subscription({ fail: failure('QUOTA') }), [keys], ({ next }) => next !== keys);

    await expect(chain.generate(req)).rejects.toMatchObject({ code: 'QUOTA' });
    expect(keys.calls).toBe(0);
  });
});

describe('runReview — cost of a method fallback (ADR-0027)', () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const review = (primary: ReviewModel, fallbacks: ReviewModel[], perReviewUsd = 0.5) =>
    runReview({
      config: makeConfig({ budget: { perReviewUsd, maxInputTokens: 200_000, pricing: { inputPerMTok: 5, outputPerMTok: 15 } } }),
      pr: { title: 'PR title', body: 'PR body' },
      files: [{ path: 'src/main.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: primary,
      fallbackModels: fallbacks,
      knownSecrets: [],
    });

  it('records the API price of the paid calls when only the auth method changed', async () => {
    const result = await review(subscription({ fail: failure('RATE_LIMIT') }), [keysBehind({ reply: makeAnswerJson([]), usage })]);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result).toMatchObject({ fallbackFromMethod: 'subscription', modelUsedMethod: 'api-key' });
    expect(result.costUsd).toBeCloseTo((100 * 5 + 50 * 15) / 1_000_000, 12);
  });

  it('keeps the cost unknown when a configured model took over (ADR-0008 §4)', async () => {
    const configured = model('xai:grok-4', 'api-key', { reply: makeAnswerJson([]), usage });
    const result = await review(subscription({ fail: failure('INVALID_CREDENTIAL') }), [keysBehind({ reply: 'unused' }), configured]);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.costUsd).toBeUndefined();
  });

  it('costs $0 while every call stays on the subscription', async () => {
    const result = await review(subscription({ reply: makeAnswerJson([]), usage }), [keysBehind({ reply: 'unused' })]);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') expect(result.costUsd).toBe(0);
  });

  it('does not move a call to paid keys when its API price exceeds what is left of the review budget', async () => {
    const keys = keysBehind({ reply: makeAnswerJson([]), usage });
    // 4096 output tokens at $15/MTok alone are about $0.06, over the $0.01 limit.
    const result = await review(subscription({ fail: failure('RATE_LIMIT') }), [keys], 0.01);

    expect(result.status).toBe('failed');
    expect(keys.calls).toBe(0);
  });
});

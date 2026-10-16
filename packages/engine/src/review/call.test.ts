import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmFailure } from '../llm/failure.js';
import { parseReviewAnswer } from './answer.js';
import {
  describePaths,
  generateWithTimeout,
  retryUnusableAnswer,
  ReviewDeadline,
  withCallTimeout,
} from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { SpendTracker } from './spend.js';

const REQUEST: ReviewModelRequest = { system: 'S', user: 'U', maxOutputTokens: 100 };

function hangingModel(seen: ReviewModelRequest[]): ReviewModel {
  return {
    label: 'zai-coding:glm-5.3',
    generate: (request) => {
      seen.push(request);
      return new Promise<ReviewModelResponse>(() => undefined);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('generateWithTimeout (ADR-0013)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a call that does not answer in time with TIMEOUT and aborts its signal', async () => {
    vi.useFakeTimers();
    const seen: ReviewModelRequest[] = [];
    const pending = rejection(generateWithTimeout(hangingModel(seen), REQUEST, 5_000));
    await vi.advanceTimersByTimeAsync(5_000);

    const error = await pending;
    expect(error).toBeInstanceOf(LlmFailure);
    expect((error as LlmFailure).code).toBe('TIMEOUT');
    expect((error as LlmFailure).message).toContain('5s');
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  it('keeps the model error when the caller aborted, and clears the timer on success', async () => {
    vi.useFakeTimers();
    const outer = new AbortController();
    const model: ReviewModel = {
      label: 'fake:abort',
      generate: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () =>
            reject(new LlmFailure({ code: 'ABORTED', provider: 'fake', message: 'request aborted' })),
          );
        }),
    };
    const pending = rejection(generateWithTimeout(model, { ...REQUEST, signal: outer.signal }, 5_000));
    outer.abort();
    expect(((await pending) as LlmFailure).code).toBe('ABORTED');

    const ok: ReviewModel = { label: 'fake:ok', generate: async () => ({ text: 'x', finishReason: 'stop' }) };
    await expect(generateWithTimeout(ok, REQUEST, 5_000)).resolves.toMatchObject({ text: 'x' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects at once with ABORTED for an already-cancelled review, without calling the model', async () => {
    const outer = new AbortController();
    outer.abort();
    const generate = vi.fn(() => new Promise<ReviewModelResponse>(() => {}));
    const model: ReviewModel = { label: 'fake:hang', generate };
    const failure = (await rejection(generateWithTimeout(model, { ...REQUEST, signal: outer.signal }, 5_000))) as LlmFailure;
    expect(failure.code).toBe('ABORTED');
    expect(generate).not.toHaveBeenCalled();
  });

  it('withCallTimeout keeps the label, headroom and disclosure fields of the wrapped model', () => {
    const base: ReviewModel = {
      label: 'fake:base',
      authMethod: 'subscription',
      includedInSubscription: true,
      fallbackTriggers: ['quota', 'rate-limit'],
      outputTokensFor: (max) => max + 8192,
      skippedFallbacks: [{ label: 'openai:gpt', reason: 'no key' }],
      generate: async () => ({ text: '', finishReason: 'stop' }),
    };
    const wrapped = withCallTimeout(base, 1_000);
    expect(wrapped.label).toBe('fake:base');
    expect(wrapped.authMethod).toBe('subscription');
    expect(wrapped.fallbackTriggers).toEqual(['quota', 'rate-limit']);
    expect(wrapped.includedInSubscription).toBe(true);
    expect(wrapped.outputTokensFor?.(4096)).toBe(4096 + 8192);
    expect(wrapped.skippedFallbacks).toEqual([{ label: 'openai:gpt', reason: 'no key' }]);
  });
});

describe('ReviewDeadline and describePaths', () => {
  it('expires once the total time has passed', () => {
    let now = 1_000;
    const deadline = new ReviewDeadline(500, () => now);
    expect(deadline.expired).toBe(false);
    now = 1_500;
    expect(deadline.expired).toBe(true);
  });

  it('lists at most 10 paths and shortens long ones from the left', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    expect(describePaths(paths)).toBe(`${paths.slice(0, 10).join(', ')} +2 more`);
    const long = `packages/${'deep/'.repeat(20)}file.ts`;
    const shown = describePaths([long]);
    expect(shown.length).toBe(60);
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.endsWith('/file.ts')).toBe(true);
  });
});

describe('retryUnusableAnswer', () => {
  const parse = (r: ReviewModelResponse) => parseReviewAnswer(r.text, { finishReason: r.finishReason });
  const empty = parseReviewAnswer('');

  it('leaves an answer that is not empty alone', async () => {
    const model: ReviewModel = { label: 'fake', generate: vi.fn() };
    const parsed = parseReviewAnswer('{"summary": "cut', { finishReason: 'max-tokens' });
    const result = await retryUnusableAnswer({
      parsed,
      model,
      spend: new SpendTracker(undefined, 1),
      request: REQUEST,
      promptTokens: 10,
      requestedOutputTokens: 100,
      parse,
    });
    expect(result.parsed).toBe(parsed);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('skips the retry, disclosed, when the budget cannot afford it', async () => {
    const model: ReviewModel = { label: 'fake', generate: vi.fn() };
    const spend = new SpendTracker({ inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }, 0.0001);
    const result = await retryUnusableAnswer({
      parsed: empty,
      model,
      spend,
      request: REQUEST,
      promptTokens: 10,
      requestedOutputTokens: 4096,
      parse,
    });
    expect(model.generate).not.toHaveBeenCalled();
    expect(result.note).toBe('empty-response retry skipped: budget limit reached');
    expect(result.parsed.ok).toBe(false);
  });

  it('discloses a failed retry with its failure code', async () => {
    const model: ReviewModel = {
      label: 'fake',
      generate: async () => {
        throw new LlmFailure({ code: 'SERVER', provider: 'fake', message: 'boom' });
      },
    };
    const result = await retryUnusableAnswer({
      parsed: empty,
      model,
      spend: new SpendTracker(undefined, 1),
      request: REQUEST,
      promptTokens: 10,
      requestedOutputTokens: 100,
      parse,
    });
    expect(result.note).toBe('empty-response retry failed: SERVER');
    expect(result.thinkingOff).toBe(false);
  });
});

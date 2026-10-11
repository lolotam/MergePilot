import { describe, expect, it, vi } from 'vitest';
import { collectText } from './collect.js';
import { LlmFailure, failureFromHttp } from './failure.js';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './retry.js';
import type { StreamChunk } from './types.js';

async function* chunks(...items: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const item of items) yield item;
}

describe('collectText', () => {
  it('joins text deltas and sums usage chunks', async () => {
    const result = await collectText(
      chunks(
        { type: 'text-delta', text: 'Hello ' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } },
        { type: 'text-delta', text: 'world' },
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 1 } },
        { type: 'finish', reason: 'stop' },
      ),
    );

    expect(result).toEqual({
      text: 'Hello world',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 },
      finishReason: 'stop',
    });
  });

  it('reports error when the stream ends without a finish chunk', async () => {
    const result = await collectText(chunks({ type: 'text-delta', text: 'cut' }));
    expect(result.finishReason).toBe('error');
  });
});

describe('failureFromHttp', () => {
  const base = { provider: 'anthropic', headers: {}, bodyText: '' };

  it.each([
    [401, 'INVALID_CREDENTIAL'],
    [403, 'INVALID_CREDENTIAL'],
    [408, 'TIMEOUT'],
    [504, 'TIMEOUT'],
    [413, 'CONTEXT_WINDOW_EXCEEDED'],
    [500, 'SERVER'],
    [529, 'SERVER'],
    [400, 'BAD_REQUEST'],
  ] as const)('maps status %i to %s', (status, code) => {
    expect(failureFromHttp({ ...base, status }).code).toBe(code);
  });

  it('separates quota exhaustion from rate limiting on 429', () => {
    expect(failureFromHttp({ ...base, status: 429, bodyText: 'Too many requests' }).code).toBe('RATE_LIMIT');
    expect(
      failureFromHttp({ ...base, status: 429, bodyText: 'You exceeded your current quota, check billing' }).code,
    ).toBe('QUOTA');
  });

  it('detects context overflow reported as a 400', () => {
    const failure = failureFromHttp({
      ...base,
      status: 400,
      bodyText: 'prompt is too long: maximum context length is 200000 tokens',
    });
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('parses retry-after in seconds and as an HTTP date', () => {
    const now = Date.parse('2026-10-11T10:00:00Z');
    expect(failureFromHttp({ ...base, status: 429, headers: { 'retry-after': '7' } }).retryAfterMs).toBe(7000);
    expect(
      failureFromHttp(
        { ...base, status: 429, headers: { 'Retry-After': 'Sun, 11 Oct 2026 10:00:30 GMT' } },
        () => now,
      ).retryAfterMs,
    ).toBe(30000);
  });

  it('keeps the request id but never copies header values into the message', () => {
    const failure = failureFromHttp({
      ...base,
      status: 401,
      headers: { 'x-api-key': 'sk-ant-test-000', 'request-id': 'req_123' },
      bodyText: 'invalid x-api-key',
    });
    expect(failure.requestId).toBe('req_123');
    expect(failure.message).not.toContain('sk-ant-test-000');
    expect(failure).toBeInstanceOf(LlmFailure);
  });
});

describe('withRetry', () => {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 1000 };
  const rateLimit = () => new LlmFailure({ code: 'RATE_LIMIT', provider: 'openai', message: 'slow down' });

  it('retries retryable failures and returns the first success', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn().mockRejectedValueOnce(rateLimit()).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, policy, { sleep, random: () => 0.5 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('stops after maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(rateLimit());
    await expect(withRetry(fn, policy, { sleep: async () => undefined, random: () => 0 })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
    expect(fn).toHaveBeenCalledTimes(policy.maxAttempts);
  });

  it('does not retry non-retryable codes or foreign errors', async () => {
    const auth = vi.fn().mockRejectedValue(new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'gemini', message: 'bad key' }));
    await expect(withRetry(auth, policy, { sleep: async () => undefined, random: () => 0 })).rejects.toThrow('bad key');
    expect(auth).toHaveBeenCalledTimes(1);

    const foreign = vi.fn().mockRejectedValue(new TypeError('boom'));
    await expect(withRetry(foreign, policy, { sleep: async () => undefined, random: () => 0 })).rejects.toThrow('boom');
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it('waits at least retryAfterMs when the provider asks for longer', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmFailure({ code: 'RATE_LIMIT', provider: 'openai', message: 'x', retryAfterMs: 5000 }))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, policy, { sleep, random: () => 1 });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('stops retrying once the signal aborts', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw rateLimit();
    });

    await expect(
      withRetry(fn, policy, { sleep: async () => undefined, random: () => 0, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

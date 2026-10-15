import { describe, expect, it } from 'vitest';
import { LlmFailure, classifyFailure, failureKind } from '../llm/failure.js';
import { callWithKeyRotation } from './key-rotation.js';

const secret = ['sk', 'rotate', 'live', '9911'].join('-');

function quota(status = 429): LlmFailure {
  return new LlmFailure({ code: 'QUOTA', provider: 'gemini', status, message: `quota for ${secret}` });
}

describe('callWithKeyRotation', () => {
  it('returns the first key and skips nothing when it succeeds', async () => {
    const seen: number[] = [];
    const outcome = await callWithKeyRotation({
      provider: 'gemini',
      keyCount: 2,
      startIndex: 0,
      call: async (index) => {
        seen.push(index);
        return 'ok';
      },
    });
    expect(outcome).toEqual({ value: 'ok', index: 0, skipped: 0 });
    expect(seen).toEqual([0]);
  });

  it('retries the next key after a 429 and reports one skip', async () => {
    const seen: number[] = [];
    const outcome = await callWithKeyRotation({
      provider: 'gemini',
      keyCount: 2,
      startIndex: 0,
      call: async (index) => {
        seen.push(index);
        if (index === 0) throw new LlmFailure({ code: 'RATE_LIMIT', provider: 'gemini', status: 429, message: `slow ${secret}` });
        return 'ok';
      },
    });
    expect(outcome).toEqual({ value: 'ok', index: 1, skipped: 1 });
    expect(seen).toEqual([0, 1]);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('throws one quota-exhausted failure when every key is exhausted, without the secret', async () => {
    const seen: number[] = [];
    const error = await callWithKeyRotation({
      provider: 'openrouter',
      keyCount: 2,
      startIndex: 0,
      call: async (index) => {
        seen.push(index);
        throw quota();
      },
    }).then(
      () => {
        throw new Error('expected failure');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LlmFailure);
    expect(error).toMatchObject({ code: 'QUOTA_EXHAUSTED_ALL_KEYS', provider: 'openrouter', status: 429 });
    expect(seen).toEqual([0, 1]);
    const failure = error as LlmFailure;
    expect(failure.message).toBe('all 2 API keys for openrouter are quota-exhausted');
    expect(failure.message).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(failureKind(failure.code)).toBe('quota');
    expect(classifyFailure(failure.code)).toBe('exhausted');
  });

  it('does not try another key after an auth error', async () => {
    const seen: number[] = [];
    await expect(
      callWithKeyRotation({
        provider: 'gemini',
        keyCount: 3,
        startIndex: 0,
        call: async (index) => {
          seen.push(index);
          throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'gemini', status: 401, message: 'rejected' });
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(seen).toEqual([0]);
  });

  it('starts at the cached index and wraps once', async () => {
    const seen: number[] = [];
    const outcome = await callWithKeyRotation({
      provider: 'opencode-zen',
      keyCount: 3,
      startIndex: 1,
      call: async (index) => {
        seen.push(index);
        if (index !== 0) throw quota();
        return 'later';
      },
    });
    expect(seen).toEqual([1, 2, 0]);
    expect(outcome).toEqual({ value: 'later', index: 0, skipped: 2 });
  });

  it('keeps a server error on the first key', async () => {
    const seen: number[] = [];
    await expect(
      callWithKeyRotation({
        provider: 'gemini',
        keyCount: 2,
        startIndex: 0,
        call: async (index) => {
          seen.push(index);
          throw new LlmFailure({ code: 'SERVER', provider: 'gemini', status: 500, message: 'down' });
        },
      }),
    ).rejects.toMatchObject({ code: 'SERVER' });
    expect(seen).toEqual([0]);
  });
});

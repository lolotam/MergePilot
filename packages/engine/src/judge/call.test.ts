import { describe, expect, it, vi } from 'vitest';
import { LlmFailure } from '../llm/failure.js';
import { hangingFetch, jsonResponse, mockFetch, textResponse } from '../providers/fetch-mock.fixtures.js';
import { callSystemOne, JudgeResponseError, type SystemOneCall } from './call.js';
import { judgeKey, noSleep, noulReply } from './judge.fixtures.js';
import { JUDGE_PROVIDER_IDS, type JudgeProviderId } from './providers.js';
import { noul } from './questions.js';

const question = { q1: noul('Is `x` equal to 1?') };

function call(provider: JudgeProviderId, fetch: SystemOneCall['fetch'], extra: Partial<SystemOneCall> = {}): Promise<unknown> {
  return callSystemOne({
    provider,
    model: 'm',
    apiKey: judgeKey(),
    state: { x: 1 },
    questions: question,
    fetch,
    sleep: noSleep,
    ...extra,
  });
}

const URLS: Record<JudgeProviderId, string> = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/v1/systemone',
  'vercel-gateway': 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  'opencode-zen': 'https://opencode.ai/zen/v1/systemone',
};

describe('callSystemOne', () => {
  it.each(JUDGE_PROVIDER_IDS)('posts the wire format to the fixed %s endpoint', async (provider) => {
    const { fetch, calls } = mockFetch(noulReply({ q1: 0.9 }));
    await call(provider, fetch);
    expect(calls[0]?.url).toBe(URLS[provider]);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${judgeKey()}`, 'content-type': 'application/json' });
    expect(calls[0]?.body).toEqual({
      model: 'm',
      state: { x: 1 },
      questions: { q1: { type: 'noul', instructions: 'Is `x` equal to 1?' } },
    });
  });

  it('ignores a base-URL override smuggled into the options', async () => {
    const { fetch, calls } = mockFetch(noulReply({ q1: 0.5 }));
    const smuggled = { baseUrl: 'https://evil.example.com' } as unknown as Partial<SystemOneCall>;
    await call('typesafe', fetch, smuggled);
    expect(calls[0]?.url).toBe(URLS.typesafe);
  });

  it('parses noul, choice and score answers with snake_case usage', async () => {
    const { fetch } = mockFetch(
      jsonResponse({
        model: 'jev-latest',
        answers: {
          a: { type: 'noul', noul: 0.82 },
          b: { type: 'choice', choice: 'yes', probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.7 },
          c: { type: 'score', score: 3, legend: ['low', 'mid', 'high'], probabilities: { '1': 0.1 }, confidence: 0.6 },
        },
        usage: { input_tokens: 42, output_tokens: 0 },
      }),
    );
    const result = await callSystemOne({
      provider: 'typesafe',
      model: 'jev-latest',
      apiKey: judgeKey(),
      state: {},
      questions: { a: noul('a'), b: { type: 'choice', instructions: 'b', criteria: { yes: null, no: null } }, c: { type: 'score', instructions: 'c', criteria: ['low', 'mid', 'high'] } },
      fetch,
    });
    expect(result.answers.a).toEqual({ type: 'noul', noul: 0.82 });
    expect(result.answers.b).toMatchObject({ type: 'choice', choice: 'yes', confidence: 0.7 });
    expect(result.answers.c).toMatchObject({ type: 'score', score: 3, confidence: 0.6 });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 0 });
    expect(result.costUsd).toBeUndefined();
  });

  it("accepts Vercel's camelCase usage and gateway cost", async () => {
    const { fetch } = mockFetch(
      jsonResponse({
        answers: { q1: { type: 'noul', noul: 0.1 } },
        usage: { inputTokens: 77, outputTokens: 0 },
        providerMetadata: { gateway: { cost: '0.000154' } },
      }),
    );
    const result = (await call('vercel-gateway', fetch)) as { usage: unknown; costUsd: number; model: string };
    expect(result.usage).toEqual({ inputTokens: 77, outputTokens: 0 });
    expect(result.costUsd).toBeCloseTo(0.000154);
    expect(result.model).toBe('m');
  });

  it('surfaces a 422 field message with the key redacted', async () => {
    const body = JSON.stringify({ detail: [{ loc: ['body', 'model'], msg: `unknown model for key ${judgeKey()}` }] });
    const { fetch } = mockFetch(textResponse(body, 422));
    const error = await call('openrouter', fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmFailure);
    const failure = error as LlmFailure;
    expect(failure.status).toBe(422);
    expect(failure.message).toContain('body.model: unknown model');
    expect(failure.message).not.toContain(judgeKey());
  });

  it('retries a 429 once, then answers', async () => {
    const sleep = vi.fn(noSleep);
    const { fetch, calls } = mockFetch(textResponse('slow down', 429, { 'retry-after': '2' }), noulReply({ q1: 0.4 }));
    await call('typesafe', fetch, { sleep });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000, expect.anything());
  });

  it('retries a 529 only once and then fails as overloaded', async () => {
    const { fetch, calls } = mockFetch(textResponse('overloaded', 529));
    const error = (await call('typesafe', fetch).catch((e: unknown) => e)) as LlmFailure;
    expect(calls).toHaveLength(2);
    expect(error.status).toBe(529);
    expect(error.code).toBe('SERVER');
  });

  it('maps 401 to an auth failure without retrying', async () => {
    const { fetch, calls } = mockFetch(textResponse('{"error":{"message":"bad key"}}', 401));
    const error = (await call('typesafe', fetch).catch((e: unknown) => e)) as LlmFailure;
    expect(calls).toHaveLength(1);
    expect(error.code).toBe('INVALID_CREDENTIAL');
  });

  it('times out a hung provider', async () => {
    const error = (await call('typesafe', hangingFetch(), { timeoutMs: 20 }).catch((e: unknown) => e)) as LlmFailure;
    expect(error.code).toBe('TIMEOUT');
  });

  it('rejects a reply that misses an answer', async () => {
    const { fetch } = mockFetch(jsonResponse({ answers: {}, usage: {} }));
    await expect(call('typesafe', fetch)).rejects.toBeInstanceOf(JudgeResponseError);
  });
});

describe('testJudgeConnection', () => {
  it('answers ok with the model, or the code and the redacted provider message', async () => {
    const { testJudgeConnection } = await import('./connection.js');
    const ok = await testJudgeConnection('opencode-zen', judgeKey(), { fetch: mockFetch(noulReply({ ok: 1 })).fetch });
    expect(ok).toMatchObject({ ok: true, model: 'jev' });
    const body = JSON.stringify({ error: { message: `model jev-x not found for ${judgeKey()}` } });
    const bad = await testJudgeConnection('openrouter', judgeKey(), { model: 'jev-x', fetch: mockFetch(textResponse(body, 404)).fetch });
    expect(bad).toMatchObject({ ok: false, code: 'model-not-found' });
    expect(bad.ok ? '' : bad.message).toContain('model jev-x not found');
    expect(JSON.stringify(bad)).not.toContain(judgeKey());
  });
});

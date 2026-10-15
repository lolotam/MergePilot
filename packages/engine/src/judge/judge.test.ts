import { describe, expect, it } from 'vitest';
import { hangingFetch, jsonResponse, mockFetch, textResponse } from '../providers/fetch-mock.fixtures.js';
import { createJudge, describeAnsweredBy, JudgeUnavailableError, type JudgeCallEvent, type JudgeEntry } from './judge.js';
import { judgeSecret, noSleep, noulReply } from './judge.fixtures.js';
import { noul } from './questions.js';

const request = { state: { x: 1 }, questions: { q1: noul('Is `x` 1?'), q2: noul('Is `x` 2?') } };

const primary: JudgeEntry = { provider: 'openrouter', model: '~typesafe/jev-latest', apiKey: judgeSecret('or') };
const fallback1: JudgeEntry = { provider: 'typesafe', model: 'jev-latest', apiKey: judgeSecret('ts') };
const fallback2: JudgeEntry = { provider: 'opencode-zen', model: 'jev-1.13-free', apiKey: judgeSecret('oc') };

describe('createJudge — fallback chain', () => {
  it('moves to fallback 1 when the primary is rate-limited (after its one retry)', async () => {
    const { fetch, calls } = mockFetch(
      textResponse('slow', 429),
      textResponse('slow', 429),
      noulReply({ q1: 0.9, q2: 0.1 }),
    );
    const events: JudgeCallEvent[] = [];
    const judge = createJudge({ entries: [primary, fallback1], fetch, sleep: noSleep, onCall: (e) => events.push(e) });
    const decision = await judge.decide(request);
    expect(calls.map((c) => c.url)).toEqual([
      'https://openrouter.ai/api/v1/systemone',
      'https://openrouter.ai/api/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
    ]);
    expect(decision.fallbackIndex).toBe(1);
    expect(decision.attempts.map((a) => [a.provider, a.ok, a.code])).toEqual([
      ['openrouter', false, 'rate-limited'],
      ['typesafe', true, undefined],
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ provider: 'typesafe', ok: true, questions: 2, fallbackIndex: 1, inputTokens: 120 });
    expect(JSON.stringify(events)).not.toContain('Is `x`');
    const report = judge.report();
    expect(report.answeredBy && describeAnsweredBy(report.answeredBy)).toBe(
      'typesafe:jev-latest (fallback 1; openrouter failed: rate-limited)',
    );
  });

  it('moves on twice: primary (auth) and fallback 1 (wrong model, 404) fail, fallback 2 answers', async () => {
    const { fetch } = mockFetch(
      textResponse('{"error":{"message":"no"}}', 401),
      textResponse('{"error":{"message":"model not found"}}', 404),
      noulReply({ q1: 0.5, q2: 0.5 }),
    );
    const judge = createJudge({ entries: [primary, fallback1, fallback2], fetch, sleep: noSleep });
    const decision = await judge.decide(request);
    expect(decision.provider).toBe('opencode-zen');
    expect(decision.fallbackIndex).toBe(2);
    expect(decision.attempts.map((a) => a.code)).toEqual(['auth', 'model-not-found', undefined]);
    // The free model has a known price of 0: cost is known.
    expect(judge.report()).toMatchObject({ inputTokens: 120, costUsd: 0 });
  });

  it('throws JudgeUnavailableError with every attempt when all entries fail', async () => {
    const { fetch } = mockFetch(textResponse('down', 503));
    const judge = createJudge({ entries: [primary, fallback1], fetch, sleep: noSleep });
    const error = (await judge.decide(request).catch((e: unknown) => e)) as JudgeUnavailableError;
    expect(error).toBeInstanceOf(JudgeUnavailableError);
    expect(error.code).toBe('server');
    expect(error.attempts).toHaveLength(2);
    expect(judge.report().unavailable).toBe('server');
  });

  it('skips a fallback without a key and discloses it', async () => {
    const { fetch, calls } = mockFetch(textResponse('down', 500), noulReply({ q1: 1, q2: 1 }));
    const judge = createJudge({
      entries: [primary, { provider: 'vercel-gateway', model: 'typesafe-ai/jev' }, fallback2],
      fetch,
      sleep: noSleep,
    });
    const decision = await judge.decide(request);
    expect(calls).toHaveLength(2);
    expect(decision.attempts.map((a) => [a.provider, a.code, a.skipped ?? false])).toEqual([
      ['openrouter', 'server', false],
      ['vercel-gateway', 'no-key', true],
      ['opencode-zen', undefined, false],
    ]);
    expect(describeAnsweredBy(judge.report().answeredBy!)).toBe(
      'opencode-zen:jev-1.13-free (fallback 2; openrouter failed: server; vercel-gateway skipped: no-key)',
    );
  });

  it('keeps a valid low-confidence answer: no fallback', async () => {
    const { fetch, calls } = mockFetch(noulReply({ q1: 0.01, q2: 0.02 }));
    const judge = createJudge({ entries: [primary, fallback1], fetch, sleep: noSleep });
    const decision = await judge.decide(request);
    expect(calls).toHaveLength(1);
    expect(decision.answers.q1).toEqual({ type: 'noul', noul: 0.01 });
  });

  it('stops trying once the total time budget is spent and discloses it', async () => {
    let clock = 0;
    const slowFail = (): Response => {
      clock += 45_000;
      return textResponse('down', 500);
    };
    const { fetch, calls } = mockFetch(slowFail, slowFail, noulReply({ q1: 1, q2: 1 }));
    const judge = createJudge({ entries: [primary, fallback1, fallback2], fetch, sleep: noSleep, now: () => clock });
    const error = (await judge.decide(request).catch((e: unknown) => e)) as JudgeUnavailableError;
    expect(calls).toHaveLength(2);
    expect(error.code).toBe('time-budget');
    expect(error.attempts.map((a) => a.code)).toEqual(['server', 'server', 'time-budget']);
  });

  it('gives each attempt at most the remaining time', async () => {
    const judge = createJudge({ entries: [primary], fetch: hangingFetch(), callTimeoutMs: 20, sleep: noSleep });
    await expect(judge.decide(request)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('keeps using the fallback that answered for the rest of the review', async () => {
    const { fetch, calls } = mockFetch(textResponse('no', 401), noulReply({ q1: 1, q2: 1 }), noulReply({ q1: 1, q2: 1 }));
    const judge = createJudge({ entries: [primary, fallback1], fetch, sleep: noSleep });
    await judge.decide(request);
    await judge.decide(request);
    expect(calls.map((c) => c.url)).toEqual([
      'https://openrouter.ai/api/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
      'https://api.typesafe.ai/v1/systemone',
    ]);
    expect(judge.report()).toMatchObject({ inputTokens: 240, outputTokens: 0 });
    expect(judge.report().attempts).toHaveLength(3);
    // The second request started at the fallback, yet still discloses why the primary was not used.
    expect(judge.report().answeredBy?.before).toEqual([
      { provider: 'openrouter', model: primary.model, code: 'auth', skipped: false },
    ]);
  });

  it('records the cost Vercel reports', async () => {
    const { fetch } = mockFetch(
      jsonResponse({
        answers: { q1: { type: 'noul', noul: 1 }, q2: { type: 'noul', noul: 1 } },
        usage: { inputTokens: 10, outputTokens: 0 },
        providerMetadata: { gateway: { cost: 0.002 } },
      }),
    );
    const judge = createJudge({ entries: [{ provider: 'vercel-gateway', model: 'typesafe-ai/jev', apiKey: judgeSecret() }], fetch });
    const decision = await judge.decide(request);
    expect(decision.costUsd).toBe(0.002);
    expect(judge.report().costUsd).toBe(0.002);
  });
});

describe('createJudge — key rotation and the time budget', () => {
  it('stops rotating keys once the total budget is spent instead of reusing the first remaining time', async () => {
    let clock = 0;
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      clock += 600;
      return textResponse('{"error":{"message":"insufficient credits"}}', 402);
    }) as typeof globalThis.fetch;
    const rotating: JudgeEntry = {
      ...primary,
      keys: [judgeSecret('k1'), judgeSecret('k2'), judgeSecret('k3')],
      startIndex: 0,
    };
    const judge = createJudge({ entries: [rotating], fetch, sleep: noSleep, now: () => clock, totalTimeoutMs: 1_000 });

    const error = await judge.decide(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JudgeUnavailableError);
    // Key 1 at t=0 and key 2 at t=600 are tried; at t=1200 the budget is gone, so key 3 is not.
    expect(urls).toHaveLength(2);
  });
});


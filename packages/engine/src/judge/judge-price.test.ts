import { describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../providers/fetch-mock.fixtures.js';
import { createJudge, type JudgeEntry } from './judge.js';
import { judgeSecret, noulReply } from './judge.fixtures.js';
import { jevModelPrice } from './providers.js';
import { noul } from './questions.js';

const request = { state: { x: 1 }, questions: { q1: noul('Is `x` 1?') } };
const openrouter: JudgeEntry = { provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: judgeSecret('or') };
const typesafe: JudgeEntry = { provider: 'typesafe', model: 'jev-latest', apiKey: judgeSecret('ts') };

describe('judge prices: catalog lookup before the static table', () => {
  it('has the OpenRouter Jev price (0.042 USD/MTok input) as the static last resort', () => {
    expect(jevModelPrice('openrouter', 'typesafe/jev-1.13')).toBe(0.042);
    expect(jevModelPrice('openrouter', '~typesafe/jev-latest')).toBe(0.042);
    expect(jevModelPrice('typesafe', 'jev-latest')).toBeUndefined();
  });

  it('uses the static price when the lookup has none', async () => {
    const { fetch } = mockFetch(noulReply({ q1: 0.9 }, { input_tokens: 1_000_000, output_tokens: 0 }));
    const judge = createJudge({ entries: [openrouter], fetch, priceLookup: () => undefined });
    expect((await judge.decide(request)).costUsd).toBeCloseTo(0.042, 9);
  });

  it('prefers the looked-up price (input and output) over the static table', async () => {
    const { fetch } = mockFetch(noulReply({ q1: 0.9 }, { input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    const judge = createJudge({
      entries: [openrouter],
      fetch,
      priceLookup: (provider, model) => (provider === 'openrouter' && model === 'typesafe/jev-1.13' ? { inputPerMTok: 0.05, outputPerMTok: 0.01 } : undefined),
    });
    expect((await judge.decide(request)).costUsd).toBeCloseTo(0.06, 9);
  });

  it('prices a provider the static table does not know, and checks the budget with it', async () => {
    const { fetch, calls } = mockFetch(noulReply({ q1: 0.9 }, { input_tokens: 2_000_000, output_tokens: 0 }));
    const lookup = () => ({ inputPerMTok: 1 });
    const priced = createJudge({ entries: [typesafe], fetch, priceLookup: lookup });
    expect((await priced.decide(request)).costUsd).toBeCloseTo(2, 9);

    const skipped = createJudge({ entries: [typesafe], fetch, priceLookup: () => ({ inputPerMTok: 1000 }) });
    await expect(skipped.decide({ ...request, maxUsd: 0.000001 })).rejects.toMatchObject({ code: 'budget' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the cost the provider reports over any price', async () => {
    const { fetch } = mockFetch(
      jsonResponse({
        answers: { q1: { type: 'noul', noul: 1 } },
        usage: { inputTokens: 10, outputTokens: 0 },
        providerMetadata: { gateway: { cost: 0.002 } },
      }),
    );
    const judge = createJudge({
      entries: [{ provider: 'vercel-gateway', model: 'typesafe-ai/jev', apiKey: judgeSecret() }],
      fetch,
      priceLookup: () => ({ inputPerMTok: 500 }),
    });
    expect((await judge.decide(request)).costUsd).toBe(0.002);
  });
});

import { describe, expect, it } from 'vitest';
import { costUsd } from '../budget/cost.js';
import { toModelPricing } from './resolve.js';

describe('toModelPricing', () => {
  it('carries the cache prices when the catalog has them', () => {
    expect(
      toModelPricing({
        provider: 'anthropic',
        model: 'm',
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        source: 'models.dev',
      }),
    ).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 });
  });

  it('prices cache tokens like input tokens when the catalog has no cache price (the config rule)', () => {
    const pricing = toModelPricing({ provider: 'openrouter', model: 'm', inputPerMTok: 2, outputPerMTok: 8, source: 'openrouter' });
    expect(pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 2, cacheWritePerMTok: 2 });
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing)).toBe(6);
  });
});

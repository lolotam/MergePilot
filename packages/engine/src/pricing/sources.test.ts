import { describe, expect, it } from 'vitest';
import {
  MODELS_DEV_PROVIDER_KEYS,
  PRICE_SOURCE_URLS,
  parseModelsDevPrices,
  parseOpenRouterPrices,
  parseVercelPrices,
} from './sources.js';

describe('parseOpenRouterPrices', () => {
  it('converts USD-per-token strings to USD per MTok and keeps cache prices', () => {
    const entries = parseOpenRouterPrices({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
        },
        { id: 'typesafe/jev-1.13', pricing: { prompt: '0.000000042', completion: '0' } },
      ],
    });
    expect(entries).toEqual([
      {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.5',
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        source: 'openrouter',
      },
      { provider: 'openrouter', model: 'typesafe/jev-1.13', inputPerMTok: 0.042, outputPerMTok: 0, source: 'openrouter' },
    ]);
  });

  it('skips dynamic "-1" prices, keeps :free models at 0, and drops invalid, huge or negative values', () => {
    const entries = parseOpenRouterPrices({
      data: [
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'meta/llama:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'bad/nan', pricing: { prompt: 'abc', completion: '0.000001' } },
        { id: 'bad/huge', pricing: { prompt: '0.002', completion: '0.000001' } },
        { id: 'bad/negative', pricing: { prompt: '-0.000001', completion: '0.000001' } },
        { id: 'bad/cache', pricing: { prompt: '0.000001', completion: '0.000001', input_cache_read: '-1' } },
        { id: 'bad/missing', pricing: { prompt: '0.000001' } },
        { id: 'bad/no-pricing' },
        { pricing: { prompt: '0', completion: '0' } },
        'not an object',
      ],
    });
    expect(entries.map((e) => e.model)).toEqual(['meta/llama:free']);
    expect(entries[0]).toMatchObject({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('returns nothing for a body of the wrong shape and keeps the first of repeated ids', () => {
    expect(parseOpenRouterPrices(null)).toEqual([]);
    expect(parseOpenRouterPrices({ data: 'x' })).toEqual([]);
    const twice = parseOpenRouterPrices({
      data: [
        { id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'a/b', pricing: { prompt: '0.000009', completion: '0.000009' } },
      ],
    });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.inputPerMTok).toBe(1);
  });
});

describe('parseVercelPrices', () => {
  it('reads input/output per token as the vercel-gateway provider and skips models without pricing', () => {
    const entries = parseVercelPrices({
      data: [
        { id: 'typesafe-ai/jev', pricing: { input: '0.00000005', output: '0' } },
        { id: 'openai/gpt-5', pricing: { input: '0.00000125', output: '0.00001', input_cache_read: '0.000000125' } },
        { id: 'image/model' },
        { id: 'bad/huge', pricing: { input: '1', output: '1' } },
      ],
    });
    expect(entries).toEqual([
      { provider: 'vercel-gateway', model: 'typesafe-ai/jev', inputPerMTok: 0.05, outputPerMTok: 0, source: 'vercel' },
      {
        provider: 'vercel-gateway',
        model: 'openai/gpt-5',
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.125,
        source: 'vercel',
      },
    ]);
  });
});

describe('parseModelsDevPrices', () => {
  const catalog = {
    anthropic: {
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context_over_200k: { input: 6, output: 22.5 } },
        },
        'no-cost': { id: 'no-cost' },
      },
    },
    google: { models: { 'gemini-2.5-pro': { id: 'gemini-2.5-pro', cost: { input: 1.25, output: 10, tiers: [{ input: 2.5 }] } } } },
    opencode: { models: { 'jev-1.13-free': { id: 'jev-1.13-free', cost: { input: 0, output: 0 } } } },
    'xiaomi-token-plan-sgp': { models: { 'mimo-v2': { id: 'mimo-v2', cost: { input: 0, output: 0 } } } },
    unmapped: { models: { x: { id: 'x', cost: { input: 1, output: 1 } } } },
    deepseek: { models: { huge: { id: 'huge', cost: { input: 5000, output: 1 } }, neg: { id: 'neg', cost: { input: -1, output: 1 } } } },
  };

  it('maps each models.dev key to our provider ids and uses the base price (tiers ignored)', () => {
    const entries = parseModelsDevPrices(catalog, MODELS_DEV_PROVIDER_KEYS);
    expect(entries).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        source: 'models.dev',
      },
      { provider: 'gemini', model: 'gemini-2.5-pro', inputPerMTok: 1.25, outputPerMTok: 10, source: 'models.dev' },
      { provider: 'opencode-zen', model: 'jev-1.13-free', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
      { provider: 'xiaomi-token-plan', model: 'mimo-v2', inputPerMTok: 0, outputPerMTok: 0, source: 'models.dev' },
    ]);
  });

  it('reads only the mapped keys', () => {
    expect(parseModelsDevPrices(catalog, { mine: 'unmapped' })).toEqual([
      { provider: 'mine', model: 'x', inputPerMTok: 1, outputPerMTok: 1, source: 'models.dev' },
    ]);
    expect(parseModelsDevPrices('nope', MODELS_DEV_PROVIDER_KEYS)).toEqual([]);
  });

  it('has the agreed mapping table and fixed https URLs', () => {
    expect(MODELS_DEV_PROVIDER_KEYS).toEqual({
      anthropic: 'anthropic',
      openai: 'openai',
      gemini: 'google',
      xai: 'xai',
      deepseek: 'deepseek',
      nvidia: 'nvidia',
      'opencode-zen': 'opencode',
      'opencode-go': 'opencode-go',
      zai: 'zai',
      'zai-coding': 'zai-coding-plan',
      xiaomi: 'xiaomi',
      'xiaomi-token-plan': 'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-cn': 'xiaomi-token-plan-cn',
      minimax: 'minimax',
      'minimax-coding-plan': 'minimax-coding-plan',
    });
    expect(PRICE_SOURCE_URLS).toEqual({
      openrouter: 'https://openrouter.ai/api/v1/models',
      vercel: 'https://ai-gateway.vercel.sh/v1/models',
      'models.dev': 'https://models.dev/api.json',
    });
  });
});

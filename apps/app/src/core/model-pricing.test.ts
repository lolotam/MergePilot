import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { judgeModelPrice, judgePriceLookup, resolvePricing } from './model-pricing.js';
import type { JudgeSettings } from './types.js';

const FETCHED = new Date('2026-10-13T02:30:00.000Z');

async function storeWithCatalog(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.replaceModelPrices(
    'models.dev',
    [
      { provider: 'anthropic', model: 'claude-x', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, source: 'models.dev' },
      { provider: 'opencode-zen', model: 'jev-1.13', inputPerMTok: 0.04, outputPerMTok: 0, source: 'models.dev' },
    ],
    FETCHED,
  );
  return store;
}

const repoPricing = { inputPerMTok: 9, outputPerMTok: 9, cacheReadPerMTok: 9, cacheWritePerMTok: 9 };

describe('resolvePricing (ADR-0016)', () => {
  it('uses the workspace override first, even over the repo file and the catalog', async () => {
    const store = await storeWithCatalog();
    const settings = { priceOverrides: [{ provider: 'anthropic', model: 'claude-x', inputPerMTok: 1, outputPerMTok: 2 }] };
    const resolved = await resolvePricing({ store, settings, repoPricing }, 'anthropic', 'claude-x');
    expect(resolved.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 1, cacheWritePerMTok: 1 });
    expect(resolved.record).toEqual({ source: 'override', inputPerMTok: 1, outputPerMTok: 2 });
  });

  it('uses the repo pricing next, then the catalog row', async () => {
    const store = await storeWithCatalog();
    const fromRepo = await resolvePricing({ store, settings: {}, repoPricing }, 'anthropic', 'claude-x');
    expect(fromRepo).toEqual({ pricing: repoPricing, record: { source: 'repo', inputPerMTok: 9, outputPerMTok: 9 } });

    const fromCatalog = await resolvePricing({ store, settings: { priceOverrides: [] } }, 'anthropic', 'CLAUDE-X');
    expect(fromCatalog.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3 });
    expect(fromCatalog.record).toEqual({
      source: 'catalog:models.dev',
      inputPerMTok: 3,
      outputPerMTok: 15,
      fetchedAt: FETCHED.toISOString(),
    });
  });

  it('is unknown (no pricing, so the cost stays null) when nothing prices the model', async () => {
    const store = await storeWithCatalog();
    const resolved = await resolvePricing({ store, settings: {} }, 'custom', 'my-model');
    expect(resolved.pricing).toBeUndefined();
    expect(resolved.record).toEqual({ source: 'unknown', inputPerMTok: null, outputPerMTok: null });
  });
});

describe('judge prices', () => {
  const judge: JudgeSettings = {
    enabled: true,
    provider: 'opencode-zen',
    model: 'jev-1.13',
    uses: ['filter', 'dedupe'],
    threshold: 0.4,
    fallback: [{ provider: 'openrouter', model: 'typesafe/jev-1.13' }, { provider: 'typesafe', model: 'jev-latest' }],
  };

  it('looks up override, then catalog; leaves the rest to the static table', async () => {
    const store = await storeWithCatalog();
    const overrides = [{ provider: 'typesafe', model: 'jev-latest', inputPerMTok: 0.07, outputPerMTok: 0 }];
    const lookup = await judgePriceLookup(store, { judge, priceOverrides: overrides });
    expect(lookup?.('opencode-zen', 'jev-1.13')).toEqual({ inputPerMTok: 0.04, outputPerMTok: 0 });
    expect(lookup?.('typesafe', 'jev-latest')).toEqual({ inputPerMTok: 0.07, outputPerMTok: 0 });
    expect(lookup?.('openrouter', 'typesafe/jev-1.13')).toBeUndefined();
    expect(await judgePriceLookup(store, { judge: { ...judge, enabled: false } })).toBeUndefined();
  });

  it('describes a judge price with its source for the prices route', async () => {
    const store = await storeWithCatalog();
    const rows = await store.listModelPrices([{ provider: 'opencode-zen', model: 'jev-1.13' }]);
    expect(judgeModelPrice(rows, [], 'opencode-zen', 'jev-1.13')).toEqual({
      price: { inputPerMTok: 0.04, outputPerMTok: 0 },
      source: 'catalog:models.dev',
      fetchedAt: FETCHED,
    });
    expect(judgeModelPrice(rows, [], 'openrouter', '~typesafe/jev-latest')).toEqual({
      price: { inputPerMTok: 0.042, outputPerMTok: 0 },
      source: 'static',
      fetchedAt: null,
    });
    expect(judgeModelPrice(rows, [], 'typesafe', 'jev-latest')).toEqual({ price: null, source: 'unknown', fetchedAt: null });
  });
});

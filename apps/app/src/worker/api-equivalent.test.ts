import { describe, expect, it, vi } from 'vitest';
import type { StoredModelPrice } from '../core/price-types.js';
import { antigravityApiModel, apiEquivalentPrice, subscriptionEquivalent } from './api-equivalent.js';

const row = (provider: string, model: string): StoredModelPrice => ({
  provider, model, inputPerMTok: 3, outputPerMTok: 15, source: 'models.dev', fetchedAt: new Date('2026-10-01T00:00:00Z'),
});

function priceStore() {
  const prices = [row('anthropic', 'claude-opus-4-6'), row('gemini', 'gemini-3.1-pro')];
  return { getModelPrice: vi.fn(async (provider: string, model: string) => prices.find((p) => p.provider === provider && p.model === model) ?? null) };
}

const subscription = { includedInSubscription: true };
const zero = { inputPerMTok: 0, outputPerMTok: 0 };

describe('Google Antigravity API-equivalent (decisions log س47-ز)', () => {
  it('maps each model to its own vendor, pricing -thinking variants as the base model', () => {
    expect(antigravityApiModel('claude-opus-4-6-thinking')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
    expect(antigravityApiModel('gemini-3.1-pro')).toEqual({ provider: 'gemini', model: 'gemini-3.1-pro' });
    expect(antigravityApiModel('gpt-oss-120b')).toBeUndefined();
  });

  it('prices a Claude model at the Anthropic catalog row', async () => {
    const store = priceStore();
    const price = await apiEquivalentPrice(store, { priceOverrides: [] }, subscription, { provider: 'google-antigravity', model: 'claude-opus-4-6' }, zero);
    expect(price).toMatchObject({ pricing: { inputPerMTok: 3, outputPerMTok: 15 }, source: 'catalog:models.dev' });
  });

  it('shows no equivalent for a model no API sells', async () => {
    expect(await apiEquivalentPrice(priceStore(), { priceOverrides: [] }, subscription, { provider: 'google-antigravity', model: 'gpt-oss-120b' }, zero)).toBeUndefined();
  });

  it('prices an Antigravity subscription entry at its vendor model', async () => {
    const result = await subscriptionEquivalent(priceStore(), { priceOverrides: [] }, [
      { label: 'google-antigravity:claude-opus-4-6', usage: { inputTokens: 100, outputTokens: 10 } },
    ]);
    expect(result?.byModel).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 100, outputTokens: 10, usd: 0.00045 }]);
    expect(result?.usd).toBe(0.00045);
  });

  it('prices no part when one subscription model has no API price, so the card leaves the run out', async () => {
    const result = await subscriptionEquivalent(priceStore(), { priceOverrides: [] }, [
      { label: 'google-antigravity:claude-opus-4-6', usage: { inputTokens: 100, outputTokens: 10 } },
      { label: 'openai:unknown', usage: { inputTokens: 999, outputTokens: 999 } },
    ]);
    expect(result).toBeUndefined();
  });
});

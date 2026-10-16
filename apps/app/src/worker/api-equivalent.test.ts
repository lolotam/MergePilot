import { describe, expect, it, vi } from 'vitest';
import type { StoredModelPrice } from '../core/price-types.js';
import { antigravityApiModel, apiEquivalentPrice } from './api-equivalent.js';

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
});

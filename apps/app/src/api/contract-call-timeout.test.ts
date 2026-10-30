import { describe, expect, it } from 'vitest';
import { SettingsUpdateSchema, ReviewerBotInputSchema } from './contract.js';

// The per-bot optional call timeout override and its REST bounds (migration 0018 / batch 2).

describe('settings contract: callTimeoutMs', () => {
  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };

  it('keeps omission a patch (undefined) and preserves an explicit null', () => {
    expect(SettingsUpdateSchema.parse(base).callTimeoutMs).toBeUndefined();
    expect(SettingsUpdateSchema.parse({ ...base, callTimeoutMs: null }).callTimeoutMs).toBeNull();
  });

  it('accepts the bounds and the override, and rejects anything outside them', () => {
    for (const callTimeoutMs of [1000, 600000, 1200000]) {
      expect(SettingsUpdateSchema.parse({ ...base, callTimeoutMs }).callTimeoutMs).toBe(callTimeoutMs);
    }
    for (const callTimeoutMs of [0, -1, 999, 1200001, 1.5, '600000', NaN, Infinity]) {
      expect(SettingsUpdateSchema.safeParse({ ...base, callTimeoutMs }).success).toBe(false);
    }
  });
});

describe('bots contract: callTimeoutMs', () => {
  const owl = {
    name: 'Owl',
    logo: 'owl',
    active: true,
    provider: 'openrouter',
    model: 'openai/gpt-5',
    effort: 'high',
    fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: null }],
  };

  it('omits the override when left out and accepts the bounds and the override', () => {
    expect(ReviewerBotInputSchema.parse(owl).callTimeoutMs).toBeUndefined();
    for (const callTimeoutMs of [1000, 600000, 1200000]) {
      expect(ReviewerBotInputSchema.parse({ ...owl, callTimeoutMs }).callTimeoutMs).toBe(callTimeoutMs);
    }
    expect(ReviewerBotInputSchema.parse({ ...owl, callTimeoutMs: null }).callTimeoutMs).toBeNull();
  });

  it('rejects out-of-range, fractional, string, NaN and Infinity values', () => {
    for (const callTimeoutMs of [0, -5, 999, 1200001, 0.5, '600000', NaN, Infinity]) {
      expect(ReviewerBotInputSchema.safeParse({ ...owl, callTimeoutMs }).success).toBe(false);
    }
  });
});

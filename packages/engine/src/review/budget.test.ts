import { describe, expect, it } from 'vitest';
import { checkBudget, costOverBudgetReason, estimateTokens, parseBudgetSkipReason } from './budget.js';

describe('estimateTokens', () => {
  it('returns ceil(chars / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1); // ceil(3/3.5) = 1
    expect(estimateTokens('a'.repeat(7))).toBe(2); // ceil(7/3.5) = 2
    expect(estimateTokens('a'.repeat(10))).toBe(3); // ceil(10/3.5) ≈ 3
    expect(estimateTokens('a'.repeat(100))).toBe(29); // ceil(100/3.5) ≈ 29
  });

  it('handles exact multiples of 3.5', () => {
    // 35 chars / 3.5 = exactly 10
    expect(estimateTokens('a'.repeat(35))).toBe(10);
  });
});

describe('checkBudget', () => {
  it('returns ok when promptTokens equals maxInputTokens', () => {
    expect(checkBudget({ promptTokens: 100, maxInputTokens: 100 })).toEqual({ ok: true });
  });

  it('returns ok when promptTokens is below the limit', () => {
    expect(checkBudget({ promptTokens: 50, maxInputTokens: 100 })).toEqual({ ok: true });
  });

  it('returns failure when promptTokens exceeds maxInputTokens', () => {
    const result = checkBudget({ promptTokens: 101, maxInputTokens: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('101');
      expect(result.reason).toContain('100');
    }
  });

  it('failure message includes both counts', () => {
    const result = checkBudget({ promptTokens: 500000, maxInputTokens: 200000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('500000');
      expect(result.reason).toContain('200000');
    }
  });
});

describe('parseBudgetSkipReason', () => {
  it('reads back the token-limit reason checkBudget builds', () => {
    const result = checkBudget({ promptTokens: 380276, maxInputTokens: 300000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(parseBudgetSkipReason(result.reason)).toEqual({ kind: 'input-tokens', promptTokens: 380276, maxInputTokens: 300000 });
    }
  });

  it('reads back the per-review cost reason', () => {
    expect(costOverBudgetReason(1.234, 0.5)).toBe('estimated $1.23 > limit $0.50');
    expect(parseBudgetSkipReason(costOverBudgetReason(1.234, 0.5))).toEqual({ kind: 'cost', estimatedUsd: 1.23, limitUsd: 0.5 });
  });

  it('returns undefined for any other text', () => {
    expect(parseBudgetSkipReason('monthly budget reached')).toBeUndefined();
    expect(parseBudgetSkipReason('Estimated prompt tokens (x) exceed maxInputTokens limit (1).')).toBeUndefined();
  });
});
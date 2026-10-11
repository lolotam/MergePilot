import { describe, expect, it } from 'vitest';
import type { ModelPricing } from '../config/schema.js';
import type { TokenUsage } from '../llm/types.js';
import { costUsd, estimateCostUsd } from './cost.js';

describe('budget/cost', () => {
  describe('costUsd', () => {
    it('calculates cost accurately with all token categories', () => {
      const usage: TokenUsage = {
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 30_000,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      };

      // Math:
      // input: 100,000 * 3.0 / 1,000,000 = 0.30
      // output: 20,000 * 15.0 / 1,000,000 = 0.30
      // cacheRead: 50,000 * 0.3 / 1,000,000 = 0.015
      // cacheWrite: 30,000 * 3.75 / 1,000,000 = 0.1125
      // Total = 0.7275
      const cost = costUsd(usage, pricing);
      expect(cost).toBeCloseTo(0.7275, 6);
      expect(cost).toBe(0.7275);
    });

    it('defaults cache prices to inputPerMTok when omitted', () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
      };

      // Math:
      // input: 100 * 2 = 200
      // output: 50 * 10 = 500
      // cacheRead: 200 * 2 (default) = 400
      // cacheWrite: 300 * 2 (default) = 600
      // Total = 1,700 / 1,000,000 = 0.0017
      const cost = costUsd(usage, pricing);
      expect(cost).toBe(0.0017);
    });

    it('defaults only cacheWritePerMTok when cacheReadPerMTok is provided', () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
        cacheReadPerMTok: 0.5,
      };

      // Math:
      // input: 100 * 2 = 200
      // output: 50 * 10 = 500
      // cacheRead: 200 * 0.5 = 100
      // cacheWrite: 300 * 2 (default) = 600
      // Total = 1,400 / 1,000,000 = 0.0014
      const cost = costUsd(usage, pricing);
      expect(cost).toBe(0.0014);
    });

    it('defaults only cacheReadPerMTok when cacheWritePerMTok is provided', () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheWriteTokens: 300,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
        cacheWritePerMTok: 4.0,
      };

      // Math:
      // input: 100 * 2 = 200
      // output: 50 * 10 = 500
      // cacheRead: 200 * 2 (default) = 400
      // cacheWrite: 300 * 4 = 1200
      // Total = 2,300 / 1,000,000 = 0.0023
      const cost = costUsd(usage, pricing);
      expect(cost).toBe(0.0023);
    });

    it('returns 0 for zero usage', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
      };
      expect(costUsd(usage, pricing)).toBe(0);
    });

    it('returns unrounded number', () => {
      const usage: TokenUsage = {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const pricing: ModelPricing = {
        inputPerMTok: 1.0,
        outputPerMTok: 1.0,
      };
      // 1 / 1,000,000 = 0.000001 (would be 0 if rounded to cents)
      const cost = costUsd(usage, pricing);
      expect(cost).toBe(0.000001);
      expect(cost).not.toBe(0);
    });
  });

  describe('estimateCostUsd', () => {
    it('calculates worst case cost assuming all input uncached and full output', () => {
      const pricing: ModelPricing = {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      };
      const estimate = {
        inputTokens: 50_000,
        maxOutputTokens: 4_096,
      };

      // Math:
      // input: 50,000 * 3.0 / 1,000,000 = 0.15
      // output: 4,096 * 15.0 / 1,000,000 = 0.06144
      // Total = 0.21144
      const cost = estimateCostUsd(estimate, pricing);
      expect(cost).toBe(0.21144);
    });

    it('returns unrounded worst case cost', () => {
      const pricing: ModelPricing = {
        inputPerMTok: 1.25,
        outputPerMTok: 5.75,
      };
      const estimate = {
        inputTokens: 10_000,
        maxOutputTokens: 2_000,
      };

      // Math: (10,000 * 1.25 + 2,000 * 5.75) / 1,000,000
      // = (12,500 + 11,500) / 1,000,000 = 24,000 / 1,000,000 = 0.024
      expect(estimateCostUsd(estimate, pricing)).toBe(0.024);
    });

    it('returns 0 for zero tokens', () => {
      const pricing: ModelPricing = {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
      };
      expect(estimateCostUsd({ inputTokens: 0, maxOutputTokens: 0 }, pricing)).toBe(0);
    });
  });
});

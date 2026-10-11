import type { ModelPricing } from '../config/schema.js';
import type { TokenUsage } from '../llm/types.js';

export interface EstimateCostInput {
  inputTokens: number;
  maxOutputTokens: number;
}

/**
 * Calculates actual review cost in USD from token usage and pricing.
 * When cache prices are omitted, they default to inputPerMTok.
 * Returns an unrounded number.
 */
export function costUsd(usage: TokenUsage, pricing: ModelPricing): number {
  const cacheReadPerMTok = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWritePerMTok = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;

  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheReadTokens * cacheReadPerMTok +
      usage.cacheWriteTokens * cacheWritePerMTok) /
    1_000_000
  );
}

/**
 * Calculates worst-case estimated cost in USD assuming all input tokens are uncached
 * and the model produces maxOutputTokens.
 * Returns an unrounded number.
 */
export function estimateCostUsd(
  estimate: EstimateCostInput,
  pricing: ModelPricing,
): number {
  return (
    (estimate.inputTokens * pricing.inputPerMTok +
      estimate.maxOutputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

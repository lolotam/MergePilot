import type { ModelPricing } from '../config/schema.js';

/** The price fields of a catalog entry or a manual override, in USD per million tokens. */
export interface PriceFields {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
}

/**
 * The engine's `ModelPricing` for a catalog entry or an override. A missing cache price is priced
 * like input tokens, the same rule as `budget.pricing` in `.mergepilot.yml`.
 */
export function toModelPricing(entry: PriceFields): ModelPricing {
  return {
    inputPerMTok: entry.inputPerMTok,
    outputPerMTok: entry.outputPerMTok,
    cacheReadPerMTok: entry.cacheReadPerMTok ?? entry.inputPerMTok,
    cacheWritePerMTok: entry.cacheWritePerMTok ?? entry.inputPerMTok,
  };
}

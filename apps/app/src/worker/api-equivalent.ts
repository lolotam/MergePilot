import { costUsd, type ModelPricing, type ReviewModel, type TokenUsage } from '@mergepilot/engine';
import { resolvePricing } from '../core/model-pricing.js';
import type { ModelPriceStore, PricingSource, RunPricing } from '../core/price-types.js';
import type { WorkspaceSettings } from '../core/types.js';

/** Flat-rate token plans priced $0 in the catalog, and the plain API provider of the same models. */
const TOKEN_PLAN_API_PROVIDER: Record<string, string> = { 'zai-coding': 'zai' };

export interface ApiEquivalentPrice {
  pricing: ModelPricing;
  source: PricingSource;
}

/**
 * The API price of a run's model when its real cost does not reflect the tokens (ADR-0024): a
 * consumer subscription (the price the bot's config was already resolved with) or a flat-rate
 * token plan (the same model under the plain API provider, the workspace's manual price first).
 * Undefined when the run is priced for real or that price is unknown, so the dashboard shows no
 * equivalent rather than a $0 one.
 */
export async function apiEquivalentPrice(
  store: Pick<ModelPriceStore, 'getModelPrice'>,
  settings: Pick<WorkspaceSettings, 'priceOverrides'>,
  model: Pick<ReviewModel, 'includedInSubscription'>,
  choice: { provider: string; model: string },
  configured: { pricing?: ModelPricing | undefined; record: RunPricing },
): Promise<ApiEquivalentPrice | undefined> {
  if (model.includedInSubscription) {
    return configured.pricing ? { pricing: configured.pricing, source: configured.record.source } : undefined;
  }
  const apiProvider = TOKEN_PLAN_API_PROVIDER[choice.provider];
  // A plan the catalog prices above $0 is charged for real: its cost needs no equivalent.
  if (!apiProvider || (configured.record.inputPerMTok ?? 0) > 0 || (configured.record.outputPerMTok ?? 0) > 0) return undefined;
  const resolved = await resolvePricing({ store, settings }, apiProvider, choice.model);
  return resolved.pricing ? { pricing: resolved.pricing, source: resolved.record.source } : undefined;
}

/** The equivalent of a completed run's own model usage (the judge's tokens are not part of it). */
export function apiEquivalentFields(
  usage: TokenUsage | undefined,
  price: ApiEquivalentPrice | undefined,
): Pick<RunPricing, 'apiEquivalentUsd' | 'apiEquivalentSource'> {
  if (!usage || !price) return {};
  return { apiEquivalentUsd: costUsd(usage, price.pricing), apiEquivalentSource: price.source };
}

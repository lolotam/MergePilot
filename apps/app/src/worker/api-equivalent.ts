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
 * consumer subscription, or a flat-rate token plan the catalog prices at a known $0 (the same
 * model under the plain API provider). The price is the workspace's manual one, then the catalog
 * row; never the repository's `budget.pricing`, which a repo file could set to anything.
 * Undefined when the run is priced for real or that price is unknown, so the dashboard shows no
 * equivalent rather than a $0 one.
 */
export async function apiEquivalentPrice(
  store: Pick<ModelPriceStore, 'getModelPrice'>,
  settings: Pick<WorkspaceSettings, 'priceOverrides'>,
  model: Pick<ReviewModel, 'includedInSubscription'>,
  choice: { provider: string; model: string },
  configured: Pick<RunPricing, 'inputPerMTok' | 'outputPerMTok'>,
): Promise<ApiEquivalentPrice | undefined> {
  let apiProvider: string | undefined;
  if (model.includedInSubscription) {
    apiProvider = choice.provider;
  } else {
    apiProvider = TOKEN_PLAN_API_PROVIDER[choice.provider];
    if (!apiProvider) return undefined;
    // Only a plan the catalog itself prices at $0 (a zero-rate manual or repo price is not that),
    // and only while nothing prices the run for real.
    const plan = await store.getModelPrice(choice.provider, choice.model);
    if (!plan || plan.inputPerMTok !== 0 || plan.outputPerMTok !== 0) return undefined;
    if (configured.inputPerMTok !== 0 || configured.outputPerMTok !== 0) return undefined;
  }
  if (!apiProvider) return undefined;
  const resolved = await resolvePricing({ store, settings }, apiProvider, choice.model);
  return resolved.pricing ? { pricing: resolved.pricing, source: resolved.record.source } : undefined;
}

/** The equivalent of a run's own model usage (the judge's tokens are not part of it). */
export function apiEquivalentFields(
  usage: TokenUsage | undefined,
  price: ApiEquivalentPrice | undefined,
): Pick<RunPricing, 'apiEquivalentUsd' | 'apiEquivalentSource'> {
  if (!usage || !price) return {};
  return { apiEquivalentUsd: costUsd(usage, price.pricing), apiEquivalentSource: price.source };
}

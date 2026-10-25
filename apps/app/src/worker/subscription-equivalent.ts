import type { TokenUsage } from '@mergepilot/engine';
import type { ModelPriceStore, RunPricing } from '../core/price-types.js';
import type { WorkspaceSettings } from '../core/types.js';
import { apiEquivalentFields, subscriptionEquivalent, type ApiEquivalentPrice } from './api-equivalent.js';

/** The subscription calls of a run, by model label (ADR-0047). */
export type SubscriptionUsage = ReadonlyArray<{ label: string; usage: TokenUsage }>;

/** What the run's pricing record shows about the API price of its tokens. */
export type EquivalentFields = Pick<RunPricing, 'apiEquivalentUsd' | 'apiEquivalentSource' | 'subscriptionPart'>;

export interface EquivalentInput {
  /** The run's own usage; the judge's tokens are not part of it. */
  usage: TokenUsage | undefined;
  /** The API price of the run's own model (ADR-0024), when it has one. */
  apiPrice: ApiEquivalentPrice | undefined;
  /** The subscription calls of the run, by model label (ADR-0047). */
  subscriptionUsage: SubscriptionUsage | undefined;
  /** True when every call of the run was on a subscription. */
  onlySubscriptionCalls: boolean;
  /** True when another model took over (ADR-0008). */
  fellBack: boolean;
  /** True when the run switched from the subscription to API keys (ADR-0027). */
  leftSubscription: boolean;
  /** The prices: the workspace's manual price first, then the catalog. */
  store: Pick<ModelPriceStore, 'getModelPrice'>;
  settings: Pick<WorkspaceSettings, 'priceOverrides'>;
}

/**
 * The API-equivalent of a run, priced for display only (ADR-0024, ADR-0047).
 *
 * A run that stayed on one subscription model keeps the ADR-0024 equivalent: the API price of
 * its own tokens, with one price lookup. A mixed run (some calls paid with API keys) or a run
 * another subscription answered gets `subscriptionPart` instead: every subscription call at the API
 * price of the model that answered it. It never sets `apiEquivalentUsd`, which the runs table shows
 * only for a run whose every call stayed on its own subscription model (ADR-0024 §5, ADR-0027 §7).
 */
export async function equivalentFields(
  input: EquivalentInput,
  onPriceFailure: (error: unknown) => void,
): Promise<EquivalentFields> {
  const usage = input.subscriptionUsage;
  const oneSubscriptionModel = input.onlySubscriptionCalls && !input.fellBack;
  if (usage === undefined && input.leftSubscription) {
    // The subscription answered no call before the switch to API keys: its part is a known
    // nothing, which tells this run apart from an older mixed run the card cannot split.
    return { subscriptionPart: { usd: 0, byModel: [], source: 'subscription' } };
  }
  if (usage === undefined || oneSubscriptionModel) {
    // A run that stayed on its own model: its own tokens at that model's API price.
    return apiEquivalentFields(input.usage, input.fellBack ? undefined : input.apiPrice);
  }
  if (usage.length === 0) return {};
  const priced = await subscriptionEquivalent(input.store, input.settings, usage).catch((error: unknown) => {
    onPriceFailure(error);
    return undefined;
  });
  // Null, not absent: the run had a subscription part the card cannot price, so it is left out.
  return { subscriptionPart: priced ?? null };
}

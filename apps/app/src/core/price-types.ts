import type { PriceEntry, PriceSource } from '@mergepilot/engine';

/** A manual price for one model, set by a workspace admin; it wins over every other source. */
export interface PriceOverride {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
}

/** A catalog price as stored in `model_prices`. */
export interface StoredModelPrice extends PriceEntry {
  fetchedAt: Date;
}

export interface ModelKey {
  provider: string;
  model: string;
}

/** The model price part of AppStore (ADR-0016). */
export interface ModelPriceStore {
  /**
   * In one transaction: upserts this source's entries and deletes this source's rows that are not
   * in the new set. Call it only for a source that fetched OK. Returns the number of entries kept.
   */
  replaceModelPrices(source: PriceSource, entries: readonly PriceEntry[], fetchedAt: Date): Promise<number>;
  /** Exact (provider, model) first, then a case-insensitive match. */
  getModelPrice(provider: string, model: string): Promise<StoredModelPrice | null>;
  /** Every row matching one of the keys, exactly or case-insensitively (pick with `pickPrice`). */
  listModelPrices(keys: readonly ModelKey[]): Promise<StoredModelPrice[]>;
  /** The newest `fetched_at` of each source that has rows. */
  pricesFetchedAt(): Promise<Array<{ source: PriceSource; fetchedAt: Date }>>;
}

const lower = (key: ModelKey): string => `${key.provider.toLowerCase()}\u0000${key.model.toLowerCase()}`;

/**
 * The row for this model among `rows`: the exact match first, then a case-insensitive one only
 * when it is unambiguous. Two ids that differ only in case may carry different prices, so the
 * price stays unknown rather than guessing between them.
 */
export function pickPrice<T extends ModelKey>(rows: readonly T[], provider: string, model: string): T | undefined {
  const exact = rows.find((r) => r.provider === provider && r.model === model);
  if (exact) return exact;
  const wanted = lower({ provider, model });
  const matches = rows.filter((r) => lower(r) === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The workspace's manual price for this model: exact first, then case-insensitive. */
export function findOverride(overrides: readonly PriceOverride[] | undefined, provider: string, model: string): PriceOverride | undefined {
  return pickPrice(overrides ?? [], provider, model);
}

/**
 * Which source priced a model: `subscription` = covered by a connected consumer subscription
 * (ADR-0020), `static` = the judge's built-in Jev table (the last resort).
 */
export type PricingSource = 'override' | 'repo' | `catalog:${PriceSource}` | 'subscription' | 'static' | 'unknown';

/** One model's display-only API-equivalent, including the tokens priced. */
export interface ApiEquivalentModel {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** `result.pricing` of a run: what priced its primary model; null prices when unknown. */
export interface RunPricing {
  source: PricingSource;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** ISO time the catalog price was fetched (catalog sources only). */
  fetchedAt?: string | undefined;
  /**
   * What the same tokens would have cost at the model's API price, for a run whose real cost does
   * not reflect them: a subscription or a flat-rate token plan (ADR-0024). Display only: never part
   * of `cost_usd`, the monthly budget or the GitHub summary. Absent when that price is unknown.
   */
  apiEquivalentUsd?: number | undefined;
  /** Subscription calls only on a mixed or subscription-fallback run (ADR-0047). */
  apiEquivalentByModel?: ApiEquivalentModel[] | undefined;
  /** Where that API price came from (`override`, `catalog:…`), when `apiEquivalentUsd` is set. */
  apiEquivalentSource?: PricingSource | undefined;
}

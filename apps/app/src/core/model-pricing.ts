import {
  jevModelPrice,
  toModelPricing,
  type JudgePriceLookup,
  type JudgeProviderId,
  type ModelPricing,
} from '@mergepilot/engine';
import { findOverride, pickPrice, type ModelPriceStore, type RunPricing, type StoredModelPrice } from './price-types.js';
import type { WorkspaceSettings } from './types.js';

export interface ResolvedPricing {
  /** The model's `budget.pricing`; undefined = unknown, so the run's cost stays null (never $0). */
  pricing?: ModelPricing | undefined;
  /** `result.pricing` for the run record. */
  record: RunPricing;
}

export interface ResolvePricingInput {
  store: Pick<ModelPriceStore, 'getModelPrice'>;
  settings: Pick<WorkspaceSettings, 'priceOverrides'>;
  /** The repo's `budget.pricing`, only when the repo file names this same provider and model. */
  repoPricing?: ModelPricing | undefined;
}

function catalogRecord(row: StoredModelPrice): RunPricing {
  return {
    source: `catalog:${row.source}`,
    inputPerMTok: row.inputPerMTok,
    outputPerMTok: row.outputPerMTok,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

/**
 * The price of a review model (ADR-0016), first of: the workspace's manual price, the repo's
 * `budget.pricing` for the same model, the catalog row, otherwise unknown.
 */
export async function resolvePricing(input: ResolvePricingInput, provider: string, model: string): Promise<ResolvedPricing> {
  const override = findOverride(input.settings.priceOverrides, provider, model);
  if (override) {
    return {
      pricing: toModelPricing(override),
      record: { source: 'override', inputPerMTok: override.inputPerMTok, outputPerMTok: override.outputPerMTok },
    };
  }
  if (input.repoPricing) {
    const p = input.repoPricing;
    return { pricing: p, record: { source: 'repo', inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok } };
  }
  const row = await input.store.getModelPrice(provider, model);
  if (row) return { pricing: toModelPricing(row), record: catalogRecord(row) };
  return { record: { source: 'unknown', inputPerMTok: null, outputPerMTok: null } };
}

/**
 * Prices for the judge and its fallbacks, read once before the review: the workspace's manual price,
 * then the catalog row. The judge itself falls back to the static Jev table when this has none.
 */
export async function judgePriceLookup(
  store: Pick<ModelPriceStore, 'listModelPrices'>,
  settings: Pick<WorkspaceSettings, 'judge' | 'priceOverrides'>,
): Promise<JudgePriceLookup | undefined> {
  const judge = settings.judge;
  if (!judge?.enabled) return undefined;
  const keys = [{ provider: judge.provider, model: judge.model }, ...judge.fallback];
  const rows = await store.listModelPrices(keys);
  return (provider, model) => {
    const price = findOverride(settings.priceOverrides, provider, model) ?? pickPrice(rows, provider, model);
    return price ? { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok } : undefined;
  };
}

/** A judge model's price for the prices route: manual, catalog, then the static Jev table. */
export function judgeModelPrice(
  rows: readonly StoredModelPrice[],
  overrides: WorkspaceSettings['priceOverrides'],
  provider: JudgeProviderId,
  model: string,
): { price: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number } | null; source: RunPricing['source']; fetchedAt: Date | null } {
  const override = findOverride(overrides, provider, model);
  if (override) return { price: priceFields(override), source: 'override', fetchedAt: null };
  const row = pickPrice(rows, provider, model);
  if (row) return { price: priceFields(row), source: `catalog:${row.source}`, fetchedAt: row.fetchedAt };
  const input = jevModelPrice(provider, model);
  if (input !== undefined) return { price: { inputPerMTok: input, outputPerMTok: 0 }, source: 'static', fetchedAt: null };
  return { price: null, source: 'unknown', fetchedAt: null };
}

/** The price fields only (no provider, model, source), cache prices only when set. */
export function priceFields(p: {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
}): { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number } {
  return {
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    ...(p.cacheReadPerMTok !== undefined ? { cacheReadPerMTok: p.cacheReadPerMTok } : {}),
    ...(p.cacheWritePerMTok !== undefined ? { cacheWritePerMTok: p.cacheWritePerMTok } : {}),
  };
}

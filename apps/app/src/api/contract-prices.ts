import { z } from 'zod';
import { API_PROVIDER_IDS, JUDGE_PROVIDER_IDS, PRICE_SOURCES } from '@mergepilot/engine';

/**
 * Model prices part of the dashboard contract (ADR-0016): the workspace's manual prices (part of
 * PUT settings, admin) and the prices route (member). Prices are USD per million tokens.
 */

export const MAX_PRICE_OVERRIDES = 50;
export const MAX_PRICE_PER_MTOK = 1000;

/** Review providers plus the judge providers: every provider a price can apply to. */
export const PRICED_PROVIDER_IDS = [...new Set<string>([...API_PROVIDER_IDS, ...JUDGE_PROVIDER_IDS])] as [string, ...string[]];

const price = (field: string) =>
  z
    .number({ message: `priceOverrides: ${field} must be a number` })
    .min(0, `priceOverrides: ${field} must be between 0 and ${MAX_PRICE_PER_MTOK} USD per million tokens`)
    .max(MAX_PRICE_PER_MTOK, `priceOverrides: ${field} must be between 0 and ${MAX_PRICE_PER_MTOK} USD per million tokens`);

export const PriceOverrideSchema = z.strictObject({
  provider: z.enum(PRICED_PROVIDER_IDS, { message: 'priceOverrides: provider must be a known review or judge provider' }),
  model: z
    .string({ message: 'priceOverrides: model is required' })
    .trim()
    .min(1, 'priceOverrides: model is required')
    .max(200, 'priceOverrides: model is too long'),
  inputPerMTok: price('inputPerMTok'),
  outputPerMTok: price('outputPerMTok'),
  cacheReadPerMTok: price('cacheReadPerMTok').optional(),
  cacheWritePerMTok: price('cacheWritePerMTok').optional(),
});
export type PriceOverrideDto = z.infer<typeof PriceOverrideSchema>;

/** Left out on PUT keeps the stored list; [] clears it. */
export const PriceOverridesSchema = z
  .array(PriceOverrideSchema, { message: 'priceOverrides must be a list' })
  .max(MAX_PRICE_OVERRIDES, `priceOverrides: at most ${MAX_PRICE_OVERRIDES} entries`);

export const PriceFieldsSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number().optional(),
  cacheWritePerMTok: z.number().optional(),
});

/** `override`, `repo` (runs only), `catalog:<source>`, `subscription` (runs only), `static` (the judge's Jev table) or `unknown`. */
export const PricingSourceSchema = z.string();

/** `result.pricing` of a run: which source priced its primary model. */
export const RunPricingSchema = z.object({
  source: PricingSourceSchema,
  inputPerMTok: z.number().nullable(),
  outputPerMTok: z.number().nullable(),
  fetchedAt: z.string().optional(),
  /** Display-only API-equivalent of a subscription or token-plan run (ADR-0024); absent when unknown. */
  apiEquivalentUsd: z.number().optional(),
  apiEquivalentSource: PricingSourceSchema.optional(),
  /** The subscription calls of a mixed or fallback run at their API price (ADR-0047); null when unpriced. */
  subscriptionPart: z.object({
    usd: z.number(),
    byModel: z.array(z.object({
      provider: z.string(),
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      usd: z.number(),
    })),
    source: PricingSourceSchema,
  }).nullable().optional(),
});

export const PRICED_MODEL_ROLES = ['primary', 'heavy', 'fallback', 'judge', 'judge-fallback'] as const;

/** GET (member) /api/workspaces/:workspaceId/prices — the price of every model the workspace uses. */
export const PricesResponseSchema = z.object({
  models: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      role: z.enum(PRICED_MODEL_ROLES),
      price: PriceFieldsSchema.nullable(),
      source: PricingSourceSchema,
      fetchedAt: z.string().nullable(),
      overridden: z.boolean(),
    }),
  ),
  sources: z.array(z.object({ source: z.enum(PRICE_SOURCES), fetchedAt: z.string().nullable() })),
});
export type PricesResponse = z.infer<typeof PricesResponseSchema>;

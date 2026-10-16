/**
 * The worker's side of the ADR-0027 method fallback: which providers have both a subscription and
 * API keys, how such a bot is admitted against the monthly budget, and how it is priced.
 */
import { SUBSCRIPTION_PREFIX, type ApiProviderId, type DualMethodConfig } from '@mergepilot/engine';
import type { Logger } from 'pino';
import { resolvePricing } from '../core/model-pricing.js';
import type { ModelPriceStore } from '../core/price-types.js';
import type { KeyProvider, WorkspaceSettings } from '../core/types.js';
import type { DualAuthState } from '../credentials/dual-auth.js';
import { isDualMethodProvider } from '../credentials/multi-key.js';
import type { BotConfig } from './bot-config.js';
import type { ProcessReviewCredentials } from './types.js';

export type DualMethods = Partial<Record<ApiProviderId, DualMethodConfig>>;

async function readDualAuth(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  provider: string,
): Promise<DualAuthState | null> {
  if (!isDualMethodProvider(provider)) return null;
  return (await credentials.getDualAuthState?.(workspaceId, provider as KeyProvider)) ?? null;
}

/**
 * The providers among `providers` that have both a subscription and API keys, with their default.
 * A provider whose state cannot be read stays on its default method alone (the Phase A behaviour),
 * so an optional method fallback never fails a review the provider could still run.
 */
export async function dualMethodsForProviders(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  providers: readonly string[],
  logger: Pick<Logger, 'warn'>,
): Promise<DualMethods> {
  const out: DualMethods = {};
  for (const provider of new Set(providers)) {
    let dual: DualAuthState | null;
    try {
      dual = await readDualAuth(credentials, workspaceId, provider);
    } catch (error) {
      logger.warn(
        { event: 'credential.dual_state_failed', provider, error: error instanceof Error ? error.name : 'unknown' },
        'Could not read both auth methods of a provider; it runs on its default method only',
      );
      continue;
    }
    if (!dual?.effective || !dual.hasSubscription || !dual.hasApiKeys) continue;
    out[provider as ApiProviderId] = { defaultMethod: dual.effective };
  }
  return out;
}

/**
 * A bot admitted as free (ADR-0022) holds no budget, so keys connected after its admission must
 * not become a paid fallback behind its subscription in this run.
 */
export function withinAdmission(dualMethods: DualMethods, admittedFree: boolean | undefined): DualMethods {
  if (!admittedFree) return dualMethods;
  return Object.fromEntries(Object.entries(dualMethods).filter(([, dual]) => dual?.defaultMethod !== 'subscription'));
}

/**
 * Budget admission: true when the bot cannot pay. A subscription default with no API keys is free;
 * with keys it may fall back to paid calls, so it reserves like a paid bot (ADR-0027). Anything
 * that cannot be read counts as paid.
 */
export async function reviewUsesSubscriptionAdmission(
  credentials: ProcessReviewCredentials,
  workspaceId: string,
  provider: string,
): Promise<boolean> {
  try {
    const dual = await readDualAuth(credentials, workspaceId, provider);
    if (dual) return dual.effective === 'subscription' && !dual.hasApiKeys;
    const effective = await credentials.getEffectiveAuthMethod?.(workspaceId, provider);
    if (effective) return effective === 'subscription';
    const secret = await credentials.resolve(workspaceId, provider as KeyProvider);
    return secret.reveal().startsWith(SUBSCRIPTION_PREFIX);
  } catch {
    return false;
  }
}

/**
 * A dual provider's calls are priced at the model's API price from trusted sources only: the
 * workspace's manual price, then the catalog (ADR-0024 lookup). Never the repository's
 * `budget.pricing`, which a repo file could set to $0 for paid fallback calls.
 */
export async function apiPricedConfig(
  config: BotConfig,
  store: Pick<ModelPriceStore, 'getModelPrice'>,
  settings: Pick<WorkspaceSettings, 'priceOverrides'>,
  choice: { provider: string; model: string },
): Promise<BotConfig> {
  const price = await resolvePricing({ store, settings }, choice.provider, choice.model);
  const { effectiveConfig } = config;
  return {
    ...config,
    effectiveConfig: { ...effectiveConfig, budget: { ...effectiveConfig.budget, pricing: price.pricing } },
    pricing: price.record,
  };
}

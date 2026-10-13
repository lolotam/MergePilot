import type { MergePilotConfig } from '@mergepilot/engine';
import type { FileContent, LoadRepoConfigResult } from '@mergepilot/github';
import { resolvePricing } from '../core/model-pricing.js';
import type { ModelPriceStore, RunPricing } from '../core/price-types.js';
import type { ApiProvider, WorkspaceSettings } from '../core/types.js';
import { effectiveConfigFor } from './effective-config.js';
import type { ModelChoice } from './model-choice.js';

export interface BotConfig {
  /** The bot's config, with `budget.pricing` set to its own model's price (ADR-0016). */
  effectiveConfig: MergePilotConfig;
  rulesFiles: FileContent[];
  /** Short hash in the review marker: a change makes the bot's next review a full one. */
  configHash: string;
  /** `result.pricing` for the bot's run record: what priced its model, or `unknown`. */
  pricing: RunPricing;
}

/**
 * One bot's review config (`effectiveConfigFor`), priced for that bot's chosen provider and model
 * (ADR-0016): workspace override, the repo's `budget.pricing` for the same model, the catalog,
 * otherwise unknown (the run's cost then stays null). Throws on an invalid repository file.
 */
export async function buildBotConfig(
  repoConfigResult: LoadRepoConfigResult,
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
  fallbackList: Array<{ provider: ApiProvider; model: string; effort?: string }>,
  settings: Pick<WorkspaceSettings, 'language' | 'minSeverity' | 'priceOverrides'>,
  store: Pick<ModelPriceStore, 'getModelPrice'>,
): Promise<BotConfig> {
  const built = effectiveConfigFor(repoConfigResult, choice, fallbackList, settings);
  const pricing = await resolvePricing({ store, settings, repoPricing: built.repoPricing }, choice.provider, choice.model);
  return {
    effectiveConfig: { ...built.config, budget: { ...built.config.budget, pricing: pricing.pricing } },
    rulesFiles: built.rulesFiles,
    configHash: built.configHash,
    pricing: pricing.record,
  };
}

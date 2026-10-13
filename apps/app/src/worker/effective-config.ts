import { createHash } from 'node:crypto';
import { MergePilotConfigSchema, type MergePilotConfig, type ModelPricing } from '@mergepilot/engine';
import type { FileContent, LoadRepoConfigResult } from '@mergepilot/github';
import type { ApiProvider, WorkspaceSettings } from '../core/types.js';
import type { ModelChoice } from './model-choice.js';

export interface EffectiveConfig {
  config: MergePilotConfig;
  rulesFiles: FileContent[];
  configHash: string;
  /** The repo's `budget.pricing`, only when the repo file names the same provider and model. */
  repoPricing?: ModelPricing | undefined;
}

/**
 * The config a SaaS review runs with. The workspace's dashboard settings choose the provider,
 * model, effort, fallbacks and review language (the repo file may target the GitHub Action, e.g.
 * `provider: claude-code`); the repo still supplies its review rules and other settings. A
 * repo-provided baseUrl never reaches the effective config: a key must not be sent to a URL from
 * repository content (ADR-0008 amendment). The price is resolved later (ADR-0016), so
 * `budget.pricing` is left empty here.
 */
export function effectiveConfigFor(
  repoConfigResult: LoadRepoConfigResult,
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
  fallbackList: Array<{ provider: ApiProvider; model: string; effort?: string }>,
  settings: Pick<WorkspaceSettings, 'language' | 'minSeverity'>,
): EffectiveConfig {
  const { provider, model, effort } = choice;
  if ('missing' in repoConfigResult) {
    return {
      config: MergePilotConfigSchema.parse({
        provider,
        model,
        ...(effort ? { effort } : {}),
        fallback: fallbackList,
        language: settings.language,
        review: { minSeverity: settings.minSeverity ?? 'medium' },
      }),
      rulesFiles: [],
      configHash: createHash('sha256')
        .update(JSON.stringify({ provider, model, language: settings.language }))
        .digest('hex')
        .slice(0, 12),
    };
  }
  if ('errors' in repoConfigResult) {
    throw new Error(`Invalid .mergepilot.yml:\n${repoConfigResult.errors.join('\n')}`);
  }
  const { baseUrl: _repoBaseUrl, effort: _repoEffort, ...repoConfig } = repoConfigResult.config;
  const sameModel = repoConfig.provider === provider && repoConfig.model === model;
  return {
    config: {
      ...repoConfig,
      provider,
      model,
      ...(effort ? { effort } : {}),
      fallback: fallbackList,
      language: settings.language,
      review: {
        ...repoConfig.review,
        minSeverity: settings.minSeverity ?? repoConfig.review.minSeverity,
      },
      budget: { ...repoConfig.budget, pricing: undefined },
    },
    rulesFiles: repoConfigResult.rulesFiles,
    configHash: createHash('sha256').update(repoConfigResult.configText).digest('hex').slice(0, 12),
    ...(sameModel && repoConfig.budget.pricing ? { repoPricing: repoConfig.budget.pricing } : {}),
  };
}

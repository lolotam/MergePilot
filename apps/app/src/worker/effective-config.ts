import { createHash } from 'node:crypto';
import { DEFAULT_MAX_FINDINGS, MergePilotConfigSchema, type MergePilotConfig, type ModelPricing } from '@mergepilot/engine';
import type { FileContent, LoadRepoConfigResult } from '@mergepilot/github';
import type { ApiProvider, WorkspaceSettings } from '../core/types.js';
import type { ModelChoice } from './model-choice.js';

export interface EffectiveConfig {
  config: MergePilotConfig;
  rulesFiles: FileContent[];
  configHash: string;
  /** The repo's `budget.pricing`, only when the repo file itself names the same provider and model. */
  repoPricing?: ModelPricing | undefined;
}

/**
 * The config a SaaS review runs with. The workspace's dashboard settings choose the provider,
 * model, effort, fallbacks and review language (the repo file may target the GitHub Action, e.g.
 * `provider: claude-code`); the repo still supplies its review rules and other settings. A
 * repo-provided baseUrl never reaches the effective config: a key must not be sent to a URL from
 * repository content (ADR-0008 amendment). The price is resolved later (ADR-0016), so
 * `budget.pricing` is left empty here. The workspace's findings limit applies when the repo file
 * leaves `review.maxFindings` out: `loadRepoConfig` fills it then, and a file's own value wins
 * (ADR-0033).
 */
export function effectiveConfigFor(
  repoConfigResult: LoadRepoConfigResult,
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
  fallbackList: Array<{ provider: ApiProvider; model: string; effort?: string }>,
  settings: Pick<WorkspaceSettings, 'language' | 'minSeverity' | 'maxFindings'>,
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
        review: {
          minSeverity: settings.minSeverity ?? 'medium',
          ...(settings.maxFindings !== undefined ? { maxFindings: settings.maxFindings } : {}),
        },
      }),
      rulesFiles: [],
      configHash: configHashOf(JSON.stringify({ provider, model, language: settings.language }), settings.maxFindings),
    };
  }
  if ('errors' in repoConfigResult) {
    throw new Error(`Invalid .mergepilot.yml:\n${repoConfigResult.errors.join('\n')}`);
  }
  const { baseUrl: _repoBaseUrl, effort: _repoEffort, ...repoConfig } = repoConfigResult.config;
  const defaulted = repoConfigResult.defaulted ?? [];
  // Repo pricing applies only to a provider and model the file itself names, never filled ones.
  const sameModel =
    !defaulted.includes('provider') && !defaulted.includes('model') && repoConfig.provider === provider && repoConfig.model === model;
  // The workspace limit is part of the config only where the file leaves review.maxFindings out.
  const inheritedLimit = defaulted.includes('maxFindings') ? repoConfig.review.maxFindings : undefined;
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
    configHash: configHashOf(repoConfigResult.configText, inheritedLimit),
    ...(sameModel && repoConfig.budget.pricing ? { repoPricing: repoConfig.budget.pricing } : {}),
  };
}

/**
 * The short config hash of the review marker: a change makes the next review a full one. A
 * workspace findings limit the review inherits is part of it (ADR-0033), except the default 5, so
 * the hashes of reviews from before the setting existed stay the same.
 */
function configHashOf(base: string, inheritedLimit: number | undefined): string {
  const inherited = inheritedLimit !== undefined && inheritedLimit !== DEFAULT_MAX_FINDINGS;
  // A structured encoding, so no repository text can hash like an inherited limit.
  const input = inherited ? JSON.stringify({ base, maxFindings: inheritedLimit }) : base;
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

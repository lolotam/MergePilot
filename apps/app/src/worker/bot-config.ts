import { createHash } from 'node:crypto';
import { MergePilotConfigSchema, type MergePilotConfig } from '@mergepilot/engine';
import type { FileContent, LoadRepoConfigResult } from '@mergepilot/github';
import type { ApiProvider, WorkspaceSettings } from '../core/types.js';
import type { ModelChoice } from './model-choice.js';

export interface BotConfig {
  effectiveConfig: MergePilotConfig;
  rulesFiles: FileContent[];
  /** Short hash in the review marker: a change makes the bot's next review a full one. */
  configHash: string;
}

/**
 * One bot's review config: the workspace (or bot) model, effort, fallbacks and language over the
 * repository's `.mergepilot.yml` rules and settings. Throws on an invalid repository file.
 */
export function buildBotConfig(
  repoConfigResult: LoadRepoConfigResult,
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
  fallbackList: Array<{ provider: ApiProvider; model: string; effort?: string }>,
  settings: Pick<WorkspaceSettings, 'language' | 'minSeverity'>,
): BotConfig {
  const { provider: chosenProvider, model: chosenModel, effort: chosenEffort } = choice;

  if ('missing' in repoConfigResult) {
    return {
      effectiveConfig: MergePilotConfigSchema.parse({
        provider: chosenProvider,
        model: chosenModel,
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        fallback: fallbackList,
        language: settings.language,
        review: { minSeverity: settings.minSeverity ?? 'medium' },
      }),
      rulesFiles: [],
      configHash: createHash('sha256')
        .update(JSON.stringify({ provider: chosenProvider, model: chosenModel, language: settings.language }))
        .digest('hex')
        .slice(0, 12),
    };
  }
  if ('errors' in repoConfigResult) {
    throw new Error(`Invalid .mergepilot.yml:\n${repoConfigResult.errors.join('\n')}`);
  }
  // In the SaaS the workspace's dashboard settings choose the provider, model, effort, fallbacks
  // and review language (the repo file may target the GitHub Action, e.g. `provider:
  // claude-code`); the repo still supplies its review rules and other settings.
  // A repo-provided baseUrl never reaches the effective config: a key must not be sent to a
  // URL from repository content (ADR-0008 amendment). The custom base URL comes only from the
  // workspace credential, through `customBaseUrl`.
  const { baseUrl: _repoBaseUrl, effort: _repoEffort, ...repoConfig } = repoConfigResult.config;
  const sameModel = repoConfig.provider === chosenProvider && repoConfig.model === chosenModel;
  return {
    effectiveConfig: {
      ...repoConfig,
      provider: chosenProvider,
      model: chosenModel,
      ...(chosenEffort ? { effort: chosenEffort } : {}),
      fallback: fallbackList,
      language: settings.language,
      review: {
        ...repoConfig.review,
        minSeverity: settings.minSeverity ?? repoConfig.review.minSeverity,
      },
      budget: sameModel ? repoConfig.budget : { ...repoConfig.budget, pricing: undefined },
    },
    rulesFiles: repoConfigResult.rulesFiles,
    configHash: createHash('sha256').update(repoConfigResult.configText).digest('hex').slice(0, 12),
  };
}

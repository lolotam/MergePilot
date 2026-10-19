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
 * (ADR-0033). The same precedence applies to budget.perReviewUsd (ADR-0036).
 */
export function effectiveConfigFor(
  repoConfigResult: LoadRepoConfigResult,
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
  fallbackList: Array<{ provider: ApiProvider; model: string; effort?: string }>,
  settings: Pick<WorkspaceSettings, 'language' | 'minSeverity' | 'maxFindings' | 'perReviewUsd'>,
  skillKey?: string | undefined,
): EffectiveConfig {
  const { provider, model, effort } = choice;
  if ('missing' in repoConfigResult) {
    return {
      config: MergePilotConfigSchema.parse({
        provider,
        model,
        ...(effort ? { effort } : {}),
        fallback: fallbackList,
        budget: { perReviewUsd: settings.perReviewUsd ?? 0.5 },
        language: settings.language,
        review: {
          minSeverity: settings.minSeverity ?? 'medium',
          ...(settings.maxFindings !== undefined ? { maxFindings: settings.maxFindings } : {}),
        },
      }),
      rulesFiles: [],
      configHash: configHashOf(JSON.stringify({ provider, model, language: settings.language }), settings.maxFindings, skillKey, settings.perReviewUsd),
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
    configHash: configHashOf(repoConfigResult.configText, inheritedLimit, skillKey, defaulted.includes('perReviewUsd') ? repoConfig.budget.perReviewUsd : undefined),
    ...(sameModel && repoConfig.budget.pricing ? { repoPricing: repoConfig.budget.pricing } : {}),
  };
}

/**
 * The short config hash of the review marker: a change makes the next review a full one. A
 * workspace findings limit the review inherits is part of it (ADR-0033), except the default 5, and
 * so is the review skill (ADR-0034, `skillKey`), except Default: the hashes of reviews from before
 * these settings existed stay the same. The inherited per-review cap follows the same rule,
 * except its default $0.50 (ADR-0036).
 */
function configHashOf(base: string, inheritedLimit: number | undefined, skillKey: string | undefined, perReviewUsd: number | undefined): string {
  const inherited = inheritedLimit !== undefined && inheritedLimit !== DEFAULT_MAX_FINDINGS;
  // A structured encoding, so no repository text can hash like an inherited limit or a skill.
  const inheritedBudget = perReviewUsd !== undefined && perReviewUsd !== 0.5;
  const input = inherited || skillKey || inheritedBudget
    ? JSON.stringify({ base, ...(inherited ? { maxFindings: inheritedLimit } : {}), ...(skillKey ? { skill: skillKey } : {}), ...(inheritedBudget ? { perReviewUsd } : {}) })
    : base;
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * The skill part of a marker's configHash (ADR-0034): the bot's own skill content hash, or in
 * consensus mode, where the panel selects files once with slot 1's marker, the skills of every
 * active bot by slot. Undefined when no bot concerned has a skill.
 */
export function skillKeyOf(bots: ReadonlyArray<{ slot: number; skill?: { contentHash: string } | undefined }>): string | undefined {
  const withSkill = bots.filter((bot) => bot.skill).map((bot) => ({ slot: bot.slot, skill: bot.skill!.contentHash }));
  if (withSkill.length === 0) return undefined;
  if (bots.length === 1) return withSkill[0]!.skill;
  return JSON.stringify(withSkill.sort((a, b) => a.slot - b.slot));
}

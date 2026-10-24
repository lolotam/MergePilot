import { isJevModel, isSubscriptionOnlyProvider, jevModelIds, providerEntry, type SubscriptionProvider } from '@mergepilot/engine';
import { DEFAULT_RUN_RETENTION_DAYS } from '../core/run-types.js';
import {
  sameBotName,
  type ApiProvider,
  type AppStore,
  type FallbackSetting,
  type JudgeSettings,
  type WorkspaceSettings,
} from '../core/types.js';
import type { Settings, SettingsUpdate } from './contract.js';

/** Applies a PUT body to the stored settings: undefined keeps, null clears (see contract). */
export function mergeSettings(
  workspaceId: string,
  current: WorkspaceSettings | null,
  update: SettingsUpdate,
): WorkspaceSettings {
  const keep = <T>(next: T | null | undefined, stored: T | null | undefined): T | null =>
    next === undefined ? (stored ?? null) : next;
  return {
    workspaceId,
    provider: update.provider,
    model: update.model,
    language: update.language,
    monthlyBudgetUsd: keep(update.monthlyBudgetUsd, current?.monthlyBudgetUsd),
    effort: keep(update.effort, current?.effort),
    heavyProvider: keep(update.heavyProvider, current?.heavyProvider),
    heavyModel: keep(update.heavyModel, current?.heavyModel),
    heavyEffort: keep(update.heavyEffort, current?.heavyEffort),
    heavyThresholdLines: keep(update.heavyThresholdLines, current?.heavyThresholdLines),
    fallback: keep(update.fallback, current?.fallback) ?? [],
    minSeverity: keep(update.minSeverity, current?.minSeverity) ?? 'medium',
    // Undefined keeps the stored value; the stores fill the default (5).
    maxFindings: update.maxFindings ?? current?.maxFindings,
    perReviewUsd: update.perReviewUsd ?? current?.perReviewUsd ?? 0.5,
    // Undefined keeps the stored value; a workspace without settings starts at the 30-day default.
    runRetentionDays:
      update.runRetentionDays !== undefined
        ? update.runRetentionDays
        : current?.runRetentionDays !== undefined ? current.runRetentionDays : DEFAULT_RUN_RETENTION_DAYS,
    repoColors: update.repoColors ?? current?.repoColors ?? {},
    // Undefined keeps the stored judge; null turns it off and clears it.
    judge: update.judge !== undefined ? update.judge : (current?.judge ?? null),
    // Undefined keeps the stored manual prices; [] clears them (ADR-0016).
    priceOverrides: update.priceOverrides ?? current?.priceOverrides ?? [],
    // The reviewer panel (ADR-0017): undefined keeps the stored value; the stores fill the defaults.
    botName: update.botName ?? current?.botName,
    botLogo: update.botLogo ?? current?.botLogo,
    panelMode: update.panelMode ?? current?.panelMode,
    panelMinAgreement: update.panelMinAgreement ?? current?.panelMinAgreement,
    exploreEnabled: update.exploreEnabled ?? current?.exploreEnabled ?? false,
    // ADR-0034: undefined keeps the stored skill (and its deleted-skill note); null is Default.
    ...(update.skillId !== undefined
      ? { skillId: update.skillId }
      : {
          ...(current?.skillId ? { skillId: current.skillId } : {}),
          ...(current?.skillRemovedName ? { skillRemovedName: current.skillRemovedName } : {}),
        }),
  };
}

/**
 * The settings to write when the request left the skill out: without the skill fields, so the
 * store keeps the stored skill and note inside its write instead of a value read earlier, which a
 * concurrent delete may have changed (ADR-0034).
 */
export function withoutSkillFields(settings: WorkspaceSettings): WorkspaceSettings {
  const { skillId: _skill, skillRemovedName: _note, ...rest } = settings;
  return rest;
}

/** A skill id from a PUT body that is not one of this workspace's skills (ADR-0034). */
export async function unknownSkillProblem(store: AppStore, workspaceId: string, skillId: string | null | undefined): Promise<SettingsProblem | null> {
  if (!skillId || (await store.getReviewSkill(workspaceId, skillId))) return null;
  return { code: 'unknown_skill', message: "That skill is not one of this workspace's skills" };
}

export interface SettingsProblem {
  code: string;
  message: string;
}

/**
 * Checks what the schema cannot: the heavy-duty model is all-or-nothing, and every model
 * the worker may switch to (heavy model, fallbacks) has a stored key in this workspace (a
 * `custom` key also needs its stored base URL). A workspace has one `custom` credential, so
 * every `custom` entry (primary, heavy or fallback) uses that one server URL.
 */
export async function validateSettings(
  store: AppStore,
  workspaceId: string,
  settings: Settings | WorkspaceSettings,
): Promise<SettingsProblem | null> {
  if (settings.monthlyBudgetUsd != null && (settings.perReviewUsd ?? 0.5) > settings.monthlyBudgetUsd) {
    return { code: 'validation_error', message: 'perReviewUsd must not exceed monthlyBudgetUsd' };
  }
  const keyProblem = keyChecker(store, workspaceId);
  const { heavyProvider, heavyModel, heavyEffort } = settings;
  if (Boolean(heavyProvider) !== Boolean(heavyModel?.trim())) {
    return { code: 'validation_error', message: 'heavyProvider and heavyModel must be set together' };
  }
  if (heavyEffort && !heavyModel) {
    return { code: 'validation_error', message: 'heavyEffort needs a heavy model' };
  }
  if (heavyProvider) {
    const problem = await keyProblem(heavyProvider, 'heavy_key_missing', 'heavy');
    if (problem) return problem;
  }

  const fallbackProblem = await validateFallback(store, workspaceId, settings, settings.fallback ?? []);
  if (fallbackProblem) return fallbackProblem;
  const priceProblem = validatePriceOverrides(settings.priceOverrides ?? []);
  if (priceProblem) return priceProblem;
  return settings.judge ? validateJudge(store, workspaceId, settings.judge) : null;
}

type KeyCheck = (provider: ApiProvider, code: string, role: string) => Promise<SettingsProblem | null>;

/** A stored key for `provider` (a `custom` key also needs its stored base URL). */
function keyChecker(store: AppStore, workspaceId: string): KeyCheck {
  return async (provider, code, role) => {
    const cred = await store.getCredential(workspaceId, provider);
    if (!cred) return { code, message: `Stored API key required for ${role} provider: ${provider}` };
    if (provider === 'custom' && !cred.baseUrl) {
      return { code, message: `The custom key for the ${role} model has no base URL; save the key again with its URL` };
    }
    return null;
  };
}

/**
 * The fallback chain of a bot (the main bot or an extra one; ADR-0017): no entry repeats the bot's
 * own model or another entry, and every entry has a stored key.
 */
export async function validateFallback(
  store: AppStore,
  workspaceId: string,
  primary: { provider: ApiProvider; model: string },
  fallback: readonly FallbackSetting[],
): Promise<SettingsProblem | null> {
  const keyProblem = keyChecker(store, workspaceId);
  const seen = new Set<string>([`${primary.provider}\u0000${primary.model}`]);
  for (const entry of fallback) {
    const id = `${entry.provider}\u0000${entry.model}`;
    if (seen.has(id)) {
      return {
        code: 'fallback_duplicate',
        message: `Fallback ${entry.provider}:${entry.model} repeats the primary model or another fallback`,
      };
    }
    seen.add(id);
    const problem = await keyProblem(entry.provider, 'fallback_key_missing', 'fallback');
    if (problem) return problem;
  }
  return null;
}

interface ProviderChoices {
  provider: string;
  heavyProvider?: string | null | undefined;
  fallback?: ReadonlyArray<{ provider: string }> | null | undefined;
}

function providersOf(config: ProviderChoices | null | undefined): Set<string> {
  if (!config) return new Set();
  return new Set([config.provider, config.heavyProvider ?? '', ...(config.fallback ?? []).map((entry) => entry.provider)].filter(Boolean));
}

/**
 * A subscription-only provider whose sign-in this server does not offer (ADR-0032: Google
 * Antigravity without its OAuth client) cannot be newly chosen. A choice already saved is kept, so
 * an admin can still save other changes and switch away from it.
 */
export function unavailableProviderProblem(
  next: ProviderChoices,
  previous: ProviderChoices | null | undefined,
  available: (provider: SubscriptionProvider) => boolean,
): SettingsProblem | null {
  const kept = providersOf(previous);
  for (const provider of providersOf(next)) {
    if (kept.has(provider) || !isSubscriptionOnlyProvider(provider) || available(provider)) continue;
    return {
      code: 'provider_unavailable',
      message: `${providerEntry(provider).label} sign-in is not configured on this server; choose another provider`,
    };
  }
  return null;
}

/** True when an extra bot of the workspace already uses this name (ignoring case and spaces around it). */
export async function botNameTakenByExtraBot(store: AppStore, workspaceId: string, name: string): Promise<boolean> {
  return (await store.listReviewerBots(workspaceId)).some((bot) => sameBotName(bot.name, name));
}

/** One manual price per model: the schema checks each entry, this checks the list. */
function validatePriceOverrides(overrides: ReadonlyArray<{ provider: string; model: string }>): SettingsProblem | null {
  const seen = new Set<string>();
  for (const o of overrides) {
    const id = `${o.provider}\u0000${o.model.toLowerCase()}`;
    if (seen.has(id)) {
      return { code: 'price_override_duplicate', message: `priceOverrides: ${o.provider}:${o.model} is listed twice` };
    }
    seen.add(id);
  }
  return null;
}

/**
 * The judge and every fallback must name one of the provider's Jev models (the owner's rule: only
 * Jev is offered), no entry may repeat, and an enabled judge needs its own key. A fallback without
 * a key is allowed: the worker skips it and discloses it.
 */
async function validateJudge(store: AppStore, workspaceId: string, judge: JudgeSettings): Promise<SettingsProblem | null> {
  const seen = new Set<string>();
  for (const [index, entry] of [judge, ...judge.fallback].entries()) {
    const role = index === 0 ? 'judge' : `judge fallback ${index}`;
    if (!isJevModel(entry.provider, entry.model)) {
      return {
        code: 'judge_model_invalid',
        message: `${role}: ${entry.provider} offers only these Jev models: ${jevModelIds(entry.provider).join(', ')}`,
      };
    }
    const id = `${entry.provider}\u0000${entry.model}`;
    if (seen.has(id)) {
      return { code: 'judge_fallback_duplicate', message: `${role} repeats ${entry.provider}:${entry.model}` };
    }
    seen.add(id);
  }
  if (judge.enabled && !(await store.getCredential(workspaceId, judge.provider))) {
    return { code: 'judge_key_missing', message: `Stored API key required for the judge provider: ${judge.provider}` };
  }
  return null;
}

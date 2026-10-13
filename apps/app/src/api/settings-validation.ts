import { isJevModel, jevModelIds } from '@mergepilot/engine';
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
  };
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

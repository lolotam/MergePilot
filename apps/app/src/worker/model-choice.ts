import { isApiProviderId } from '@mergepilot/engine';
import { listPullRequestFiles, type GitHubClient } from '@mergepilot/github';
import { assertSafeBaseUrl, type DnsLookupFn } from '../core/ssrf.js';
import type { ApiProvider, AppStore, WorkspaceSettings } from '../core/types.js';

/** Default "large PR" size when the workspace set a heavy model but no threshold. */
export const DEFAULT_HEAVY_THRESHOLD_LINES = 800;

export interface ModelChoice {
  provider: ApiProvider;
  model: string;
  effort: string | null;
  /** True when the PR is large enough for the workspace's heavy-duty model. */
  heavy: boolean;
}

/** The workspace model, or its heavy-duty model when the PR changes at least the threshold. */
export function chooseModel(settings: WorkspaceSettings, changedLines: number): ModelChoice {
  const threshold = settings.heavyThresholdLines ?? DEFAULT_HEAVY_THRESHOLD_LINES;
  const heavyModel = settings.heavyModel?.trim();
  if (heavyModel && changedLines >= threshold) {
    return {
      provider: settings.heavyProvider ?? settings.provider,
      model: heavyModel,
      // The primary model's effort is not carried over: it may not fit another model.
      effort: settings.heavyEffort ?? null,
      heavy: true,
    };
  }
  return { provider: settings.provider, model: settings.model, effort: settings.effort ?? null, heavy: false };
}

/**
 * The PR's changed lines (additions + deletions) for the heavy-model threshold. Taken from the
 * PR payload; when it does not carry the counts, they are summed from the PR's file list so a
 * missing field never silently keeps a large PR on the light model.
 */
export async function changedLinesOf(
  client: GitHubClient,
  params: { owner: string; repo: string; pull_number: number },
  pr: { additions?: unknown; deletions?: unknown },
): Promise<number> {
  if (typeof pr.additions === 'number' && typeof pr.deletions === 'number') return pr.additions + pr.deletions;
  const { files } = await listPullRequestFiles(client, params);
  return files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
}

export interface UsedModel {
  provider: string;
  model: string;
  effort: string | null;
  fallbackFrom: string | null;
}

/**
 * What actually answered, for the run record: the chosen model, or, when an explicit fallback
 * took over (ADR-0008), that fallback (parsed from its `provider:model` label) and its effort.
 */
export function usedModel(
  choice: ModelChoice,
  settings: WorkspaceSettings,
  modelUsed: string | undefined,
  fallbackFrom: string | undefined,
): UsedModel {
  const configured = { provider: choice.provider, model: choice.model, effort: choice.effort };
  if (!fallbackFrom || !modelUsed) return { ...configured, fallbackFrom: null };
  const colon = modelUsed.indexOf(':');
  const provider = colon > 0 ? modelUsed.slice(0, colon) : '';
  const model = colon > 0 ? modelUsed.slice(colon + 1) : '';
  if (!isApiProviderId(provider) || !model) return { ...configured, fallbackFrom };
  const entry = (settings.fallback ?? []).find((f) => f.provider === provider && f.model === model);
  return { provider, model, effort: entry?.effort ?? null, fallbackFrom };
}

/**
 * The workspace's `custom` server URL, when the chosen model or a fallback needs it. It is
 * checked here and again on every request by the guarded fetch the worker hands to the engine
 * (ADR-0010); it never comes from repository content. A primary `custom` model with a bad URL
 * fails the review clearly; a `custom` fallback with one is left out, and the engine discloses
 * the skipped fallback in the summary.
 */
export async function customBaseUrlFor(
  store: AppStore,
  workspaceId: string,
  primary: ApiProvider,
  fallbacks: readonly ApiProvider[],
  lookup?: DnsLookupFn,
): Promise<string | undefined> {
  if (primary !== 'custom' && !fallbacks.includes('custom')) return undefined;
  const cred = await store.getCredential(workspaceId, 'custom');
  if (!cred?.baseUrl) {
    if (primary === 'custom') throw new Error('The custom provider key has no base URL; save it again in Settings');
    return undefined;
  }
  if (primary === 'custom') return assertSafeBaseUrl(cred.baseUrl, lookup);
  try {
    return await assertSafeBaseUrl(cred.baseUrl, lookup);
  } catch {
    return undefined;
  }
}

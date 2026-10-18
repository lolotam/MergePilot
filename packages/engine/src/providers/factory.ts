import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import { credentialEnvName, type AnyCredentialStore } from '../credentials/store.js';
import { LlmFailure } from '../llm/failure.js';
import type { ReviewModel, SkippedFallback } from '../review/model.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { buildMethodModel, otherMethodEntry, type DualMethodConfig, type MethodModel, type OtherMethod } from './dual-method.js';
import type { FetchLike } from './http.js';
import { isApiProviderId, type ApiProviderId } from './ids.js';
import type { KeyRotationEvent } from './key-rotation.js';
import {
  createAdapter,
  rosterFor,
  rotatingReviewModel,
  withRetries,
  type KeyRoster,
  type RotationContext,
} from './model-builders.js';

export { createAdapter, CUSTOM_BASE_URL_MISSING, type KeyRoster } from './model-builders.js';
export type { DualMethodConfig } from './dual-method.js';

export interface CreateReviewModelOptions {
  cwd: string;
  /** Return a disclosure reason to exclude a configured fallback from model construction. */
  skipFallback?: ((entry: NonNullable<MergePilotConfig['fallback']>[number]) => string | undefined) | undefined;
  /**
   * Per dual-method provider (ADR-0027): both subscription and API keys are connected. The engine
   * inserts the other method immediately after each such provider in the fallback chain.
   */
  dualMethods?: Partial<Record<ApiProviderId, DualMethodConfig>> | undefined;
  /** claude-code only: isolated CLAUDE_CONFIG_DIR so no runner-level settings or hooks apply. */
  configDir?: string;
  /**
   * The `custom` server URL, from a TRUSTED source only: the Action's `custom-base-url` input /
   * `CUSTOM_LLM_BASE_URL`, or workspace settings. Never `.mergepilot.yml`: the config's own
   * `baseUrl` is ignored, so a key is never sent to a URL that came from repository content.
   */
  customBaseUrl?: string | undefined;
  /**
   * `custom` only: the fetch used to call the custom server. A shell that takes the URL from
   * its users (the SaaS) passes a guarded fetch here that re-checks the address on every call
   * and never follows redirects (SSRF / DNS rebinding). Presets always use the global fetch.
   */
  customFetch?: FetchLike | undefined;
  /**
   * Ordered API keys per provider (ADR-0026). Absent, or an empty list, keeps today's single key.
   * The engine does not load them: the app passes the roster in.
   */
  keyRosters?: Readonly<Record<string, KeyRoster>> | undefined;
  /** Key index used and how many keys were skipped. Never receives the key. */
  onKeyRotation?: ((event: KeyRotationEvent) => void) | undefined;
}

/**
 * The key for one provider, or undefined for a keyless custom server. A store that answers
 * for another provider than the one asked (a shell store bound to a single key) counts as
 * "not configured", so a key is never sent to a provider it does not belong to.
 */
async function resolveKey(store: AnyCredentialStore, provider: ApiProviderId): Promise<Secret | undefined> {
  const info = await store.info({ provider });
  const configured = info.configured && info.provider === provider;
  if (!configured && provider === 'custom') return undefined;
  if (!configured) {
    throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider, message: `no API key is configured for ${provider}` });
  }
  return store.resolve({ provider }, 'review');
}

export interface ResolvedFallbacks {
  /** Usable fallback models, in configured order; each honours its own `effort`. */
  models: ReviewModel[];
  /** The fallback keys, resolved BEFORE any model call so the prompt can be redacted of them. */
  secrets: Secret[];
  /** Entries left out (no key, or not buildable), each with a reason the review discloses. */
  skipped: SkippedFallback[];
}

/**
 * The configured fallback chain (ADR-0008), resolved up front. A missing fallback key never
 * stops a review the primary model can finish: that entry is skipped with a disclosed reason.
 */
export async function resolveFallbacks(
  config: MergePilotConfig,
  store: AnyCredentialStore,
  customBaseUrl?: string,
  customFetch?: FetchLike,
  rotation?: Pick<RotationContext, 'rosters' | 'onKeyRotation'>,
  dualMethods?: Partial<Record<ApiProviderId, DualMethodConfig>> | undefined,
  skipFallback?: CreateReviewModelOptions['skipFallback'],
): Promise<ResolvedFallbacks> {
  const resolved: ResolvedFallbacks = { models: [], secrets: [], skipped: [] };
  for (const entry of config.fallback ?? []) {
    const label = `${entry.provider}:${entry.model}`;
    const reason = skipFallback?.(entry);
    if (reason !== undefined) {
      // Skipped models still contribute credentials to prompt redaction.
      try {
        const key = await resolveKey(store, entry.provider);
        if (key) resolved.secrets.push(key);
      } catch {
        // An unavailable skipped credential must not stop the primary review.
      }
      const roster = rosterFor(rotation, entry.provider);
      if (roster) resolved.secrets.push(...roster.keys);
      if (dualMethods?.[entry.provider]?.defaultMethod === 'api-key') {
        try {
          resolved.secrets.push(await store.resolve({ provider: entry.provider, method: 'subscription' }, 'review'));
        } catch {
          // The unused method's credential is optional and must never build a model.
        }
      }
      resolved.skipped.push({ label, reason });
      continue;
    }
    let key: Secret | undefined;
    try {
      key = await resolveKey(store, entry.provider);
    } catch {
      resolved.skipped.push({ label, reason: `no API key is configured (${credentialEnvName(entry.provider)})` });
      continue;
    }
    if (key) resolved.secrets.push(key);
    const roster = rosterFor(rotation, entry.provider);
    if (roster) {
      for (const secret of roster.keys) resolved.secrets.push(secret);
    }
    if (entry.provider === 'custom' && !customBaseUrl?.trim()) {
      resolved.skipped.push({ label, reason: 'no trusted base URL is configured (CUSTOM_LLM_BASE_URL)' });
      continue;
    }
    const rot: RotationContext = { ...rotation, customBaseUrl, customFetch };
    const spec = { provider: entry.provider, model: entry.model, effort: entry.effort };
    const dual = dualMethods?.[entry.provider];
    const resolveSecret = () => store.resolve({ provider: entry.provider }, 'review');
    try {
      const built: MethodModel = dual
        ? await buildMethodModel(spec, dual.defaultMethod, store, rot)
        : {
            model: roster
              ? rotatingReviewModel(entry.provider, entry.model, entry.effort, roster, rot, resolveSecret)
              : withRetries(createAdapter(entry.provider, key, customBaseUrl, customFetch, resolveSecret), entry.model, entry.effort),
            secrets: [],
          };
      resolved.models.push(built.model);
      resolved.secrets.push(...built.secrets);
    } catch {
      resolved.skipped.push({ label, reason: 'the provider could not be set up' });
      continue;
    }
    // ADR-0027: the same provider and model on its other method, right behind its default.
    if (dual) addOtherMethod(resolved, await otherMethodEntry(spec, dual.defaultMethod, store, rot));
  }
  return resolved;
}

function addOtherMethod(resolved: ResolvedFallbacks, other: OtherMethod): void {
  if (other.model) resolved.models.push(other.model);
  resolved.secrets.push(...other.secrets);
  if (other.skipped) resolved.skipped.push(other.skipped);
}

/**
 * Every provider key a review with this config may send: the primary key (none for a keyless
 * `custom` server) plus each configured fallback key that is present. Shells pass these to the
 * pipeline as known secrets. A missing primary key still throws, as before.
 */
export async function resolveReviewSecrets(config: MergePilotConfig, store: AnyCredentialStore): Promise<Secret[]> {
  const primary =
    config.provider === 'custom'
      ? await resolveKey(store, 'custom')
      : await store.resolve({ provider: config.provider }, 'review');
  const fallbacks = await resolveFallbacks(config, store);
  return [...(primary ? [primary] : []), ...fallbacks.secrets];
}

/** What rides along on the primary model: fallbacks, every key to redact, and skipped entries. */
function attachments(primaryKey: Secret | undefined, fallbacks: ResolvedFallbacks, extra: readonly Secret[] = []) {
  const seen = new Set<Secret>();
  const secrets: Secret[] = [];
  for (const secret of [...(primaryKey ? [primaryKey] : []), ...fallbacks.secrets, ...extra]) {
    if (seen.has(secret)) continue;
    seen.add(secret);
    secrets.push(secret);
  }
  return {
    ...(fallbacks.models.length > 0 ? { fallbacks: fallbacks.models } : {}),
    secrets,
    ...(fallbacks.skipped.length > 0 ? { skippedFallbacks: fallbacks.skipped } : {}),
  };
}

/**
 * Creates a ReviewModel for the given config and credential store. It never switches models on
 * its own: the explicit fallbacks from the config ride along as `fallbacks`, and only the review
 * pipeline uses them, always disclosing the switch (ADR-0008).
 */
export async function createReviewModel(
  config: MergePilotConfig,
  store: AnyCredentialStore,
  opts: CreateReviewModelOptions,
): Promise<ReviewModel> {
  const rotation: RotationContext = {
    rosters: opts.keyRosters,
    onKeyRotation: opts.onKeyRotation,
    customBaseUrl: opts.customBaseUrl,
    customFetch: opts.customFetch,
  };
  if (config.provider === 'claude-code') {
    const token = await store.resolve({ provider: 'claude-code' }, 'review');
    const runner = new ClaudeCodeRunner({
      token,
      cwd: opts.cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    });
    return Object.assign(
      runner,
      attachments(token, await resolveFallbacks(config, store, opts.customBaseUrl, opts.customFetch, rotation, undefined, opts.skipFallback)),
    );
  }

  if (!isApiProviderId(config.provider)) {
    throw new Error(`Unsupported provider: ${String(config.provider)}`);
  }
  const provider = config.provider;
  const apiKey =
    provider === 'custom' ? await resolveKey(store, provider) : await store.resolve({ provider }, 'review');
  // `config.baseUrl` is deliberately NOT read: it comes from the repository (ADR-0008 amendment).
  if (!config.model) {
    throw new Error(`Model is required for provider: ${config.provider}`);
  }
  const resolveSecret = () => store.resolve({ provider }, 'review');
  const roster = rosterFor(rotation, provider);
  const spec = { provider, model: config.model, effort: config.effort };
  const dual = opts.dualMethods?.[provider];
  const primary: MethodModel = dual
    ? await buildMethodModel(spec, dual.defaultMethod, store, rotation)
    : {
        model: roster
          ? rotatingReviewModel(provider, config.model, config.effort, roster, rotation, resolveSecret)
          : withRetries(createAdapter(provider, apiKey, opts.customBaseUrl, opts.customFetch, resolveSecret), config.model, config.effort),
        secrets: roster ? [...roster.keys] : [],
      };
  // The chain: [primary, primary's other method (ADR-0027), configured fallbacks (ADR-0008)...].
  const chain: ResolvedFallbacks = { models: [], secrets: [...primary.secrets], skipped: [] };
  if (dual) addOtherMethod(chain, await otherMethodEntry(spec, dual.defaultMethod, store, rotation));
  const configured = await resolveFallbacks(config, store, opts.customBaseUrl, opts.customFetch, rotation, opts.dualMethods, opts.skipFallback);
  chain.models.push(...configured.models);
  chain.secrets.push(...configured.secrets);
  chain.skipped.push(...configured.skipped);
  return { ...primary.model, ...attachments(apiKey, chain) };
}

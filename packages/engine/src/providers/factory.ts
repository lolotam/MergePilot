import type { MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import { credentialEnvName, type AnyCredentialStore } from '../credentials/store.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { LlmFailure } from '../llm/failure.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';
import { modelFromAdapter, type ReviewModel, type SkippedFallback } from '../review/model.js';
import { AnthropicAdapter } from './anthropic/adapter.js';
import { ClaudeCodeRunner } from './claude-code/runner.js';
import { OpenAICompatibleAdapter } from './compatible/adapter.js';
import { GeminiAdapter } from './gemini/adapter.js';
import { isApiProviderId, type ApiProviderId } from './ids.js';
import { OpenAIAdapter } from './openai/adapter.js';
import { providerEntry } from './registry.js';

export interface CreateReviewModelOptions {
  cwd: string;
  /** claude-code only: isolated CLAUDE_CONFIG_DIR so no runner-level settings or hooks apply. */
  configDir?: string;
}

/** One API adapter for a provider id; `custom` may run without a key (a local server). */
export function createAdapter(provider: ApiProviderId, apiKey: Secret | undefined, baseUrl?: string): LlmAdapter {
  const entry = providerEntry(provider);
  if (entry.kind === 'openai-compatible') {
    return new OpenAICompatibleAdapter({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) });
  }
  if (!apiKey) throw new Error(`An API key is required for provider: ${provider}`);
  if (provider === 'anthropic') return new AnthropicAdapter({ apiKey });
  if (provider === 'openai') return new OpenAIAdapter({ apiKey });
  return new GeminiAdapter({ apiKey });
}

/** Wraps a model so each call is retried by the adapter's own policy before anything else. */
function withRetries(adapter: LlmAdapter, model: string, effort: string | undefined): ReviewModel {
  const base = modelFromAdapter(adapter, model, effort);
  const policy = adapter.retryPolicy ?? DEFAULT_RETRY_POLICY;
  return {
    label: base.label,
    ...(base.outputTokensFor ? { outputTokensFor: base.outputTokensFor } : {}),
    generate(request) {
      return withRetry(
        () => base.generate(request),
        policy,
        request.signal
          ? { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random: Math.random, signal: request.signal }
          : undefined,
      );
    },
  };
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
export async function resolveFallbacks(config: MergePilotConfig, store: AnyCredentialStore): Promise<ResolvedFallbacks> {
  const resolved: ResolvedFallbacks = { models: [], secrets: [], skipped: [] };
  for (const entry of config.fallback ?? []) {
    const label = `${entry.provider}:${entry.model}`;
    let key: Secret | undefined;
    try {
      key = await resolveKey(store, entry.provider);
    } catch {
      resolved.skipped.push({ label, reason: `no API key is configured (${credentialEnvName(entry.provider)})` });
      continue;
    }
    if (key) resolved.secrets.push(key);
    try {
      resolved.models.push(withRetries(createAdapter(entry.provider, key, entry.baseUrl), entry.model, entry.effort));
    } catch {
      resolved.skipped.push({ label, reason: 'the provider could not be set up' });
    }
  }
  return resolved;
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
function attachments(primaryKey: Secret | undefined, fallbacks: ResolvedFallbacks) {
  return {
    ...(fallbacks.models.length > 0 ? { fallbacks: fallbacks.models } : {}),
    secrets: [...(primaryKey ? [primaryKey] : []), ...fallbacks.secrets],
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
  if (config.provider === 'claude-code') {
    const token = await store.resolve({ provider: 'claude-code' }, 'review');
    const runner = new ClaudeCodeRunner({
      token,
      cwd: opts.cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    });
    return Object.assign(runner, attachments(token, await resolveFallbacks(config, store)));
  }

  if (!isApiProviderId(config.provider)) {
    throw new Error(`Unsupported provider: ${String(config.provider)}`);
  }
  const provider = config.provider;
  const apiKey =
    provider === 'custom' ? await resolveKey(store, provider) : await store.resolve({ provider }, 'review');
  const adapter = createAdapter(provider, apiKey, config.baseUrl);

  if (!config.model) {
    throw new Error(`Model is required for provider: ${config.provider}`);
  }
  const model = withRetries(adapter, config.model, config.effort);
  return { ...model, ...attachments(apiKey, await resolveFallbacks(config, store)) };
}

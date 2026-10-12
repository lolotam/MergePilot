import type { FallbackEntry, MergePilotConfig } from '../config/schema.js';
import type { Secret } from '../credentials/secret.js';
import type { AnyCredentialStore } from '../credentials/store.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { LlmFailure } from '../llm/failure.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';
import { modelFromAdapter, type ReviewModel } from '../review/model.js';
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

/**
 * A fallback model whose key is resolved on first use, so a missing fallback key never stops a
 * review the primary model can finish; it fails as `auth` and the chain moves on.
 */
function lazyFallback(entry: FallbackEntry, store: AnyCredentialStore): ReviewModel {
  let built: Promise<ReviewModel> | undefined;
  return {
    label: `${entry.provider}:${entry.model}`,
    async generate(request) {
      built ??= resolveKey(store, entry.provider).then((key) =>
        withRetries(createAdapter(entry.provider, key, entry.baseUrl), entry.model, entry.effort),
      );
      const model = await built.catch((error: unknown) => {
        built = undefined;
        throw error;
      });
      return model.generate(request);
    },
  };
}

/** The configured fallback chain (ADR-0008) as lazy review models, in order. */
export function createFallbackModels(config: MergePilotConfig, store: AnyCredentialStore): ReviewModel[] {
  return (config.fallback ?? []).map((entry) => lazyFallback(entry, store));
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
  const fallbacks = createFallbackModels(config, store);
  if (config.provider === 'claude-code') {
    const token = await store.resolve({ provider: 'claude-code' }, 'review');
    const runner = new ClaudeCodeRunner({
      token,
      cwd: opts.cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    });
    return fallbacks.length > 0 ? Object.assign(runner, { fallbacks }) : runner;
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
  return fallbacks.length > 0 ? { ...model, fallbacks } : model;
}

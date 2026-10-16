/**
 * The building blocks `createReviewModel` assembles a chain from: one adapter per credential,
 * the adapter's own retries, and the ADR-0026 key rotation over an ordered roster.
 */
import type { Secret } from '../credentials/secret.js';
import { decodeSubscription, isSubscriptionProvider } from '../credentials/subscription.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { LlmFailure } from '../llm/failure.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';
import { modelFromAdapter, type ReviewModel } from '../review/model.js';
import { AnthropicAdapter } from './anthropic/adapter.js';
import { OpenAICompatibleAdapter } from './compatible/adapter.js';
import { GeminiAdapter } from './gemini/adapter.js';
import type { FetchLike } from './http.js';
import type { ApiProviderId } from './ids.js';
import { callWithKeyRotation, type KeyRotationEvent } from './key-rotation.js';
import { OpenAIAdapter } from './openai/adapter.js';
import { providerEntry } from './registry.js';
import { SubscriptionAdapter } from './subscription/adapter.js';

/** Ordered keys for one provider. `startIndex` is 0-based and advances after a successful call. */
export interface KeyRoster {
  keys: readonly Secret[];
  startIndex: number;
}

export interface RotationContext {
  rosters?: Readonly<Record<string, KeyRoster>> | undefined;
  onKeyRotation?: ((event: KeyRotationEvent) => void) | undefined;
  customBaseUrl?: string | undefined;
  customFetch?: FetchLike | undefined;
}

export const CUSTOM_BASE_URL_MISSING =
  'provider "custom" needs a trusted base URL (CUSTOM_LLM_BASE_URL / the custom-base-url input); .mergepilot.yml baseUrl is ignored';

/**
 * One API adapter for a provider id; `custom` may run without a key (a local server). Presets
 * always call their fixed registry URL; `customBaseUrl` is used for `custom` only and must be
 * trusted (see CreateReviewModelOptions).
 */
export function createAdapter(
  provider: ApiProviderId,
  apiKey: Secret | undefined,
  customBaseUrl?: string,
  customFetch?: FetchLike,
  resolveSubscriptionSecret?: () => Promise<Secret>,
): LlmAdapter {
  if (apiKey && decodeSubscription(apiKey.reveal(), provider)) {
    if (!isSubscriptionProvider(provider)) throw new Error('Subscription authentication is unavailable for this provider');
    return new SubscriptionAdapter(provider, apiKey, resolveSubscriptionSecret);
  }
  const entry = providerEntry(provider);
  if (entry.kind === 'openai-compatible') {
    if (provider === 'custom' && !customBaseUrl?.trim()) throw new Error(CUSTOM_BASE_URL_MISSING);
    return new OpenAICompatibleAdapter({
      provider,
      apiKey,
      ...(provider === 'custom' && customBaseUrl ? { baseUrl: customBaseUrl } : {}),
      ...(provider === 'custom' && customFetch ? { fetch: customFetch } : {}),
    });
  }
  if (!apiKey) throw new Error(`An API key is required for provider: ${provider}`);
  if (provider === 'anthropic') return new AnthropicAdapter({ apiKey });
  if (provider === 'openai') return new OpenAIAdapter({ apiKey });
  return new GeminiAdapter({ apiKey });
}

export function rosterFor(rotation: RotationContext | undefined, provider: string): KeyRoster | undefined {
  const roster = rotation?.rosters?.[provider];
  return roster && roster.keys.length > 0 ? roster : undefined;
}

function notifyRotation(onKeyRotation: RotationContext['onKeyRotation'], event: KeyRotationEvent): void {
  try {
    onKeyRotation?.(event);
  } catch {
    // Disclosure must not fail a call that already succeeded.
  }
}

/**
 * One adapter per key, outside `withRetry`, so a rate-limit retry stays on the same key. The
 * wrapper keeps the auth method and subscription flag of the adapters it rotates over, so the
 * chain prices and discloses it like the single-key model (ADR-0027).
 */
export function rotatingReviewModel(
  provider: ApiProviderId,
  model: string,
  effort: string | undefined,
  roster: KeyRoster,
  rotation: RotationContext,
  resolveSubscriptionSecret?: () => Promise<Secret>,
): ReviewModel {
  let cursor = roster.startIndex;
  const sample = withRetries(
    createAdapter(provider, roster.keys[0], rotation.customBaseUrl, rotation.customFetch, resolveSubscriptionSecret),
    model,
    effort,
  );
  return {
    label: sample.label,
    ...(sample.authMethod ? { authMethod: sample.authMethod } : {}),
    ...(sample.includedInSubscription ? { includedInSubscription: true } : {}),
    ...(sample.outputTokensFor ? { outputTokensFor: sample.outputTokensFor } : {}),
    ...(sample.answerTokensFor ? { answerTokensFor: sample.answerTokensFor } : {}),
    async generate(request) {
      const outcome = await callWithKeyRotation({
        provider,
        keyCount: roster.keys.length,
        startIndex: cursor,
        call: (index) => {
          const key = roster.keys[index];
          if (!key) {
            throw new LlmFailure({
              code: 'INVALID_CREDENTIAL',
              provider,
              message: `no API key is configured for ${provider}`,
            });
          }
          return withRetries(
            createAdapter(provider, key, rotation.customBaseUrl, rotation.customFetch, resolveSubscriptionSecret),
            model,
            effort,
          ).generate(request);
        },
      });
      cursor = outcome.index;
      notifyRotation(rotation.onKeyRotation, { provider, index: outcome.index, skipped: outcome.skipped });
      return outcome.value;
    },
  };
}

/** Wraps a model so each call is retried by the adapter's own policy before anything else. */
export function withRetries(adapter: LlmAdapter, model: string, effort: string | undefined): ReviewModel {
  const base = modelFromAdapter(adapter, model, effort);
  const policy = adapter.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const subscription = adapter instanceof SubscriptionAdapter;
  return {
    label: base.label,
    authMethod: subscription ? 'subscription' : 'api-key',
    ...(subscription ? { includedInSubscription: true } : {}),
    ...(base.outputTokensFor ? { outputTokensFor: base.outputTokensFor } : {}),
    ...(base.answerTokensFor ? { answerTokensFor: base.answerTokensFor } : {}),
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

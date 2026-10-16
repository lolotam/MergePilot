/**
 * The ADR-0027 method fallback. A provider that has both a connected subscription and API keys
 * gets its effective default method first and, right behind it, the same provider and model on
 * the other method. That second entry is entered only on quota or rate limit, so an expired or
 * revoked subscription (auth) is never silently paid for with keys.
 */
import type { Secret } from '../credentials/secret.js';
import type { AnyCredentialStore } from '../credentials/store.js';
import { decodeSubscription } from '../credentials/subscription.js';
import { LlmFailure, type FailureKind } from '../llm/failure.js';
import type { ReviewAuthMethod, ReviewModel, SkippedFallback } from '../review/model.js';
import type { ApiProviderId } from './ids.js';
import { createAdapter, rosterFor, rotatingReviewModel, withRetries, type RotationContext } from './model-builders.js';

export interface DualMethodConfig {
  /** The provider's effective default method; the other one follows it in the chain. */
  defaultMethod: ReviewAuthMethod;
}

const METHOD_FALLBACK_TRIGGERS: readonly FailureKind[] = ['quota', 'rate-limit'];

/** A model for one method, plus every secret it sends so the prompt is redacted of them. */
export interface MethodModel {
  model: ReviewModel;
  secrets: Secret[];
}

export interface ModelSpec {
  provider: ApiProviderId;
  model: string;
  effort: string | undefined;
}

/**
 * The model for one auth method. API keys rotate over the roster (ADR-0026). The subscription is
 * asked for by name: a plain `resolve` answers with the effective default, which is an API key
 * when keys are the default. Its resolver runs again before each call, so a token refresh during
 * the review still happens (ADR-0020).
 */
export async function buildMethodModel(
  spec: ModelSpec,
  method: ReviewAuthMethod,
  store: AnyCredentialStore,
  rotation: RotationContext,
): Promise<MethodModel> {
  const { provider, model, effort } = spec;
  if (method === 'api-key') {
    const roster = rosterFor(rotation, provider);
    if (!roster) {
      throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider, message: `no API key is configured for ${provider}` });
    }
    return { model: rotatingReviewModel(provider, model, effort, roster, rotation), secrets: [...roster.keys] };
  }
  const resolveSubscription = async (): Promise<Secret> => {
    const secret = await store.resolve({ provider, method: 'subscription' }, 'review');
    if (!decodeSubscription(secret.reveal(), provider)) {
      throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider, message: `no subscription is connected for ${provider}` });
    }
    return secret;
  };
  const envelope = await resolveSubscription();
  return {
    model: withRetries(createAdapter(provider, envelope, rotation.customBaseUrl, rotation.customFetch, resolveSubscription), model, effort),
    secrets: [envelope],
  };
}

/** The other-method entry, or why it cannot take part; the reason is fixed text, never the error. */
export interface OtherMethod {
  model?: ReviewModel;
  secrets: Secret[];
  skipped?: SkippedFallback;
}

export async function otherMethodEntry(
  spec: ModelSpec,
  defaultMethod: ReviewAuthMethod,
  store: AnyCredentialStore,
  rotation: RotationContext,
): Promise<OtherMethod> {
  const method: ReviewAuthMethod = defaultMethod === 'subscription' ? 'api-key' : 'subscription';
  try {
    const built = await buildMethodModel(spec, method, store, rotation);
    return { model: { ...built.model, fallbackTriggers: METHOD_FALLBACK_TRIGGERS }, secrets: built.secrets };
  } catch {
    // Disclosed like any configured entry that cannot take part (ADR-0008), never dropped silently.
    const reason = method === 'subscription' ? 'the subscription could not be set up' : 'the API keys could not be set up';
    return { secrets: [], skipped: { label: `${spec.provider}:${spec.model}`, reason } };
  }
}

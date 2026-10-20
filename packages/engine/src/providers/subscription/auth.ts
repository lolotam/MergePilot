import type { AuthInteraction } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import type { PiSubscriptionProvider, SubscriptionCredential, SubscriptionProvider } from '../../credentials/subscription.js';
import {
  antigravityClientFromEnv,
  isAntigravityConfigured,
  loginAntigravity,
  refreshAntigravity,
  SubscriptionLoginError,
  type AntigravityDeps,
} from './antigravity/index.js';
import { SubscriptionRefreshError } from './refresh-error.js';

export { SubscriptionRefreshError, type SubscriptionRefreshDetails, type SubscriptionRefreshFailure } from './refresh-error.js';

export type { AuthEvent as SubscriptionAuthEvent, AuthPrompt as SubscriptionAuthPrompt } from '@earendil-works/pi-ai';
export type SubscriptionInteraction = AuthInteraction;
export {
  ANTIGRAVITY_CLIENT_ID_ENV,
  ANTIGRAVITY_CLIENT_SECRET_ENV,
  SUBSCRIPTION_LOGIN_FAILURES,
  SubscriptionLoginError,
  type SubscriptionLoginFailure,
} from './antigravity/index.js';

/** Provider-owned OAuth and request protocols, shared with DeepSeek Harness's pi-ai integration. */
export function subscriptionProvider(provider: PiSubscriptionProvider) {
  if (provider === 'openai') return openaiCodexProvider();
  if (provider === 'anthropic') return anthropicProvider();
  return xaiProvider();
}

/**
 * Whether this deployment can offer the subscription. Google Antigravity needs its OAuth client
 * configured on the server (ADR-0032); the pi-ai subscriptions are always available.
 */
export function isSubscriptionAvailable(provider: SubscriptionProvider, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return provider === 'google-antigravity' ? isAntigravityConfigured(env) : true;
}

/** The OAuth client, or `missing()` thrown: a server without it is an operator problem, not the user's. */
function antigravityDeps(missing: () => Error): AntigravityDeps {
  const client = antigravityClientFromEnv();
  if (!client) throw missing();
  return { client };
}

export async function loginSubscription(provider: SubscriptionProvider, interaction: SubscriptionInteraction): Promise<SubscriptionCredential> {
  if (provider === 'google-antigravity') {
    return loginAntigravity(interaction, antigravityDeps(() => new SubscriptionLoginError('not-configured')));
  }
  const oauth = subscriptionProvider(provider).auth.oauth!;
  return oauth.login({
    ...interaction,
    signal: interaction.signal ?? new AbortController().signal,
    prompt(prompt) {
      // Headless server flows never bind a localhost callback port on the deployment host.
      if (prompt.type === 'select') {
        const method = provider === 'openai' ? 'device_code' : 'copy_code';
        if (prompt.options.some((option) => option.id === method)) return Promise.resolve(method);
      }
      return interaction.prompt(prompt);
    },
  }, { agentName: 'MergePilot' });
}

/**
 * Fails with `SubscriptionRefreshError` only. Google Antigravity says whether the failure is
 * transient; pi-ai failures are classified from their HTTP status (429, 5xx or no answer are
 * retryable, anything else means the sign-in has to be redone).
 */
export async function refreshSubscription(provider: SubscriptionProvider, credential: SubscriptionCredential, signal: AbortSignal): Promise<SubscriptionCredential> {
  try {
    if (provider === 'google-antigravity') {
      return await refreshAntigravity(credential, antigravityDeps(() => new SubscriptionRefreshError('not-configured')), signal);
    }
    return await subscriptionProvider(provider).auth.oauth!.refresh(credential, signal);
  } catch (error) {
    if (error instanceof SubscriptionRefreshError) throw error;
    // Upstream errors may contain token-response bodies; never return them to the dashboard or logs.
    throw classifyPiRefreshFailure(error);
  }
}

/** The HTTP status in pi-ai's error text, e.g. `status=400`. */
const PI_REFRESH_STATUS = /status=(\d{3})\b/;
/** The OAuth error code in the token response body, e.g. `"error":"invalid_grant"`. */
const PI_REFRESH_OAUTH_ERROR = /"error"\s*:\s*"([a-z_]{1,64})"/;
/** A network failure or a timeout in pi-ai's error text. */
const PI_REFRESH_NETWORK = /TimeoutError|AbortError|fetch failed/;

/**
 * The message of an error and of its causes, joined for classification only. The text is never
 * stored, logged or attached to the error the dashboard sees.
 */
function refreshErrorText(error: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (typeof error === 'string') return error;
  if (!(error instanceof Error)) return '';
  const cause = error.cause;
  const causeText = cause === undefined ? '' : refreshErrorText(cause, depth + 1);
  return causeText ? `${error.message} ${causeText}` : error.message;
}

/**
 * Classifies a pi-ai refresh failure from its HTTP status and its OAuth error code: a 429, a 5xx or
 * no answer at all may clear on a later attempt, everything else means the sign-in is no longer
 * valid. Only the parsed status and code leave this function; the upstream text is discarded.
 */
function classifyPiRefreshFailure(error: unknown): SubscriptionRefreshError {
  const text = refreshErrorText(error);
  const statusText = PI_REFRESH_STATUS.exec(text)?.[1];
  const status = statusText === undefined ? undefined : Number(statusText);
  const oauthError = PI_REFRESH_OAUTH_ERROR.exec(text)?.[1];
  const network = PI_REFRESH_NETWORK.test(text)
    || error instanceof TypeError
    || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
  const retryable = status === 429 || (status !== undefined && status >= 500) || (status === undefined && network);
  return new SubscriptionRefreshError(retryable ? 'unreachable' : 'sign-in', { status, oauthError });
}


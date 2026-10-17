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

export { SubscriptionRefreshError, type SubscriptionRefreshFailure } from './refresh-error.js';

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
 * transient; pi-ai's errors carry no such classification, so they stay "sign in again".
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
    throw new SubscriptionRefreshError('sign-in');
  }
}

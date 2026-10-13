import type { AuthInteraction } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import type { SubscriptionCredential, SubscriptionProvider } from '../../credentials/subscription.js';

export type { AuthEvent as SubscriptionAuthEvent, AuthPrompt as SubscriptionAuthPrompt } from '@earendil-works/pi-ai';
export type SubscriptionInteraction = AuthInteraction;

/** Provider-owned OAuth and request protocols, shared with DeepSeek Harness's pi-ai integration. */
export function subscriptionProvider(provider: SubscriptionProvider) {
  if (provider === 'openai') return openaiCodexProvider();
  if (provider === 'anthropic') return anthropicProvider();
  return xaiProvider();
}

export async function loginSubscription(provider: SubscriptionProvider, interaction: SubscriptionInteraction): Promise<SubscriptionCredential> {
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

export async function refreshSubscription(provider: SubscriptionProvider, credential: SubscriptionCredential, signal: AbortSignal): Promise<SubscriptionCredential> {
  try {
    return await subscriptionProvider(provider).auth.oauth!.refresh(credential, signal);
  } catch {
    // Upstream errors may contain token-response bodies; never return them to the dashboard or logs.
    throw new Error('Subscription token refresh failed; sign in again');
  }
}

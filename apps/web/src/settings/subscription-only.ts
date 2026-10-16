import type { SUBSCRIPTION_ONLY_PROVIDER_IDS as ServerSubscriptionOnlyIds } from '@mergepilot/app/contract';

/** Providers with no API keys (ADR-0032), checked against the server list by type; the web does not load app runtime code. */
export const SUBSCRIPTION_ONLY_PROVIDER_IDS: typeof ServerSubscriptionOnlyIds = ['google-antigravity'];

export function isSubscriptionOnlyProvider(provider: string): provider is (typeof SUBSCRIPTION_ONLY_PROVIDER_IDS)[number] {
  return (SUBSCRIPTION_ONLY_PROVIDER_IDS as readonly string[]).includes(provider);
}

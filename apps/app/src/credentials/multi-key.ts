/** Providers that store an ordered list of API keys (ADR-0026). One list, so adding a provider is one entry. */
export const MULTI_KEY_PROVIDER_IDS = ['gemini', 'openrouter', 'opencode-zen'] as const;

/** Subscription providers that may also store API keys in slots (ADR-0027). */
export const DUAL_METHOD_PROVIDER_IDS = ['anthropic', 'openai', 'xai'] as const;

export type MultiKeyProviderId = (typeof MULTI_KEY_PROVIDER_IDS)[number];
export type DualMethodProviderId = (typeof DUAL_METHOD_PROVIDER_IDS)[number];

/** Server and UI share this cap. Positions are 0 .. MAX_PROVIDER_KEYS - 1. */
export const MAX_PROVIDER_KEYS = 20;

export function isMultiKeyProvider(provider: string): provider is MultiKeyProviderId {
  return (MULTI_KEY_PROVIDER_IDS as readonly string[]).includes(provider);
}

export function isDualMethodProvider(provider: string): provider is DualMethodProviderId {
  return (DUAL_METHOD_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** Multi-key rotation list (ADR-0026) or dual-method key slots (ADR-0027). */
export function isKeyListProvider(provider: string): boolean {
  return isMultiKeyProvider(provider) || isDualMethodProvider(provider);
}

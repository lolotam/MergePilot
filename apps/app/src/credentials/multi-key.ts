/** Providers that store an ordered list of API keys (ADR-0026). One list, so adding a provider is one entry. */
export const MULTI_KEY_PROVIDER_IDS = ['gemini', 'openrouter', 'opencode-zen'] as const;

export type MultiKeyProviderId = (typeof MULTI_KEY_PROVIDER_IDS)[number];

/** Server and UI share this cap. Positions are 0 .. MAX_PROVIDER_KEYS - 1. */
export const MAX_PROVIDER_KEYS = 20;

export function isMultiKeyProvider(provider: string): provider is MultiKeyProviderId {
  return (MULTI_KEY_PROVIDER_IDS as readonly string[]).includes(provider);
}

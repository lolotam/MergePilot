/**
 * Every API provider id MergePilot can call with a customer-owned key (ADR-0002, ADR-0008).
 * `claude-code` is not here: it runs the official CLI on the user's own subscription
 * (ADR-0006) and is not an API provider.
 */
export const API_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'deepseek',
  'nvidia',
  'openrouter',
  'vercel-gateway',
  'opencode-zen',
  'opencode-go',
  'zai',
  'zai-coding',
  'custom',
  'xiaomi',
  'xiaomi-token-plan',
  'xiaomi-token-plan-cn',
] as const;

export type ApiProviderId = (typeof API_PROVIDER_IDS)[number];

/** Every provider id a config can name. */
export const PROVIDER_IDS = [...API_PROVIDER_IDS, 'claude-code'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isApiProviderId(value: string): value is ApiProviderId {
  return (API_PROVIDER_IDS as readonly string[]).includes(value);
}

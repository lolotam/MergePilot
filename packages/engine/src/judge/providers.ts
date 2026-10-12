/**
 * The Jev judge providers (ADR-0015). Every provider serves the same TypeSafe "System One" wire
 * format at `{baseUrl}/v1/systemone`. Base URLs are fixed constants, never user-overridable
 * (ADR-0008 amendment, ADR-0010), and each provider offers ONLY its Jev models (owner's rule):
 * edit `JUDGE_PROVIDERS` below to change an id; nothing else hard-codes one.
 */

export const JUDGE_PROVIDER_IDS = ['typesafe', 'openrouter', 'vercel-gateway', 'opencode-zen'] as const;
export type JudgeProviderId = (typeof JUDGE_PROVIDER_IDS)[number];

/** Judge providers whose key is used for nothing else: stored as credentials, never review providers. */
export const JUDGE_KEY_ONLY_PROVIDER_IDS = ['typesafe', 'vercel-gateway'] as const;
export type JudgeKeyOnlyProviderId = (typeof JUDGE_KEY_ONLY_PROVIDER_IDS)[number];

export interface JevModel {
  id: string;
  /** USD per million input tokens when known (Jev bills input only); undefined = unknown. */
  inputPerMTok?: number | undefined;
}

export interface JudgeProviderEntry {
  id: JudgeProviderId;
  label: string;
  baseUrl: string;
  /** The first model is the default. */
  models: readonly JevModel[];
  /** Environment variable the Action reads the key from. */
  envName: string;
}

/**
 * The per-provider Jev model table. The OpenRouter id is not confirmed against the live API: a
 * wrong id shows up as the provider's own (redacted) 4xx message in the key test.
 */
export const JUDGE_PROVIDERS: Readonly<Record<JudgeProviderId, JudgeProviderEntry>> = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai',
    models: [{ id: 'jev-latest' }],
    envName: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    models: [{ id: '~typesafe/jev-latest' }, { id: 'typesafe/jev-1.13' }],
    envName: 'OPENROUTER_API_KEY',
  },
  'vercel-gateway': {
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/typesafe',
    models: [{ id: 'typesafe-ai/jev' }],
    envName: 'AI_GATEWAY_API_KEY',
  },
  'opencode-zen': {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen',
    models: [{ id: 'jev-1.13-free', inputPerMTok: 0 }, { id: 'jev-1.13' }],
    envName: 'OPENCODE_API_KEY',
  },
};

export function isJudgeProviderId(value: string): value is JudgeProviderId {
  return (JUDGE_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isJudgeKeyOnlyProviderId(value: string): value is JudgeKeyOnlyProviderId {
  return (JUDGE_KEY_ONLY_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The Jev model ids a provider offers, default first. */
export function jevModelIds(provider: JudgeProviderId): string[] {
  return JUDGE_PROVIDERS[provider].models.map((m) => m.id);
}

export function defaultJevModel(provider: JudgeProviderId): string {
  return jevModelIds(provider)[0] ?? '';
}

export function isJevModel(provider: JudgeProviderId, model: string): boolean {
  return jevModelIds(provider).includes(model);
}

export function jevModelPrice(provider: JudgeProviderId, model: string): number | undefined {
  return JUDGE_PROVIDERS[provider].models.find((m) => m.id === model)?.inputPerMTok;
}

/** The fixed endpoint; nothing a caller passes can change it. */
export function systemOneUrl(provider: JudgeProviderId): string {
  return `${JUDGE_PROVIDERS[provider].baseUrl}/v1/systemone`;
}

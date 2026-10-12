/**
 * One entry per API provider (ADR-0008). The OpenAI-compatible presets are ported from the
 * owner's Browser-controle extension (`src/lib/settings.js` COMPATIBLE_PRESETS and
 * `chatModelsFor`), converted to TypeScript. Consumer-subscription logins from that repo
 * (ChatGPT, Google account) are deliberately not ported (ADR-0004).
 */
import type { ThinkingStyle } from './effort.js';
import { API_PROVIDER_IDS, type ApiProviderId } from './ids.js';

export type ProviderKind = 'native' | 'openai-compatible';

export interface ProviderEntry {
  id: ApiProviderId;
  /** English label for pickers. */
  label: string;
  kind: ProviderKind;
  /** API root. For `custom` this is only a placeholder: the config must give its own. */
  baseUrl: string;
  /** Known key prefix, for UI validation only; undefined when the provider's keys have none. */
  keyHint?: string;
  thinkingStyle: ThinkingStyle;
  /** Suggested model; empty for `custom`, whose models are the user's own. */
  defaultModel: string;
  /** Environment variable the Action's `EnvCredentialStore` reads the key from. */
  envName: string;
  /** True when the config must supply `baseUrl` (only `custom`). */
  requiresBaseUrl: boolean;
  /** Compatible presets known to accept `stream_options.include_usage`. */
  streamUsage: boolean;
}

type EntryInit = Omit<ProviderEntry, 'id' | 'requiresBaseUrl' | 'streamUsage'> &
  Partial<Pick<ProviderEntry, 'requiresBaseUrl' | 'streamUsage'>>;

const ENTRIES: Record<ApiProviderId, EntryInit> = {
  anthropic: {
    label: 'Anthropic',
    kind: 'native',
    baseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-',
    thinkingStyle: 'anthropic',
    defaultModel: 'claude-sonnet-5-5',
    envName: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    kind: 'native',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-',
    thinkingStyle: 'reasoning_effort',
    defaultModel: 'gpt-5',
    envName: 'OPENAI_API_KEY',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'native',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyHint: 'AIza',
    thinkingStyle: 'gemini',
    defaultModel: 'gemini-3.8-flash',
    envName: 'GEMINI_API_KEY',
  },
  xai: {
    label: 'xAI (Grok)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-',
    thinkingStyle: 'reasoning_effort',
    defaultModel: 'grok-4',
    envName: 'XAI_API_KEY',
    streamUsage: true,
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    keyHint: 'sk-',
    thinkingStyle: 'none',
    defaultModel: 'deepseek-chat',
    envName: 'DEEPSEEK_API_KEY',
    streamUsage: true,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    kind: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyHint: 'nvapi-',
    thinkingStyle: 'none',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    envName: 'NVIDIA_API_KEY',
    streamUsage: true,
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-',
    thinkingStyle: 'reasoning_effort',
    defaultModel: 'openai/gpt-5',
    envName: 'OPENROUTER_API_KEY',
    streamUsage: true,
  },
  'opencode-zen': {
    label: 'OpenCode Zen',
    kind: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    thinkingStyle: 'none',
    defaultModel: 'glm-5.3',
    envName: 'OPENCODE_API_KEY',
  },
  'opencode-go': {
    label: 'OpenCode Go',
    kind: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    thinkingStyle: 'none',
    defaultModel: 'glm-5.3',
    envName: 'OPENCODE_API_KEY',
  },
  zai: {
    label: 'Z.ai GLM (API)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    thinkingStyle: 'glm',
    defaultModel: 'glm-4.6',
    envName: 'ZAI_API_KEY',
  },
  'zai-coding': {
    label: 'Z.ai GLM Coding Plan',
    kind: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    thinkingStyle: 'glm',
    defaultModel: 'glm-4.6',
    envName: 'ZAI_API_KEY',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    thinkingStyle: 'reasoning_effort',
    defaultModel: '',
    envName: 'CUSTOM_LLM_API_KEY',
    requiresBaseUrl: true,
  },
};

export const PROVIDER_REGISTRY: Readonly<Record<ApiProviderId, Readonly<ProviderEntry>>> = Object.freeze(
  Object.fromEntries(
    API_PROVIDER_IDS.map((id) => [
      id,
      Object.freeze({ id, requiresBaseUrl: false, streamUsage: false, ...ENTRIES[id] }),
    ]),
  ) as Record<ApiProviderId, ProviderEntry>,
);

export function providerEntry(id: ApiProviderId): Readonly<ProviderEntry> {
  return PROVIDER_REGISTRY[id];
}

/** All entries in display order. */
export function listProviders(): ReadonlyArray<Readonly<ProviderEntry>> {
  return API_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]);
}

/**
 * OpenCode serves each model family on its own endpoint: GPT, Grok and Muse on /responses,
 * Claude, some Qwen and (on Go) MiniMax on /messages, Gemini on Google's path, Jev on
 * /systemone. MergePilot speaks /chat/completions to them, so those families are left out.
 */
const NOT_CHAT_COMPLETIONS: Partial<Record<ApiProviderId, RegExp>> = {
  'opencode-zen': /^(gpt-|grok-|muse-spark|claude-|gemini-|jev-|qwen3\.(8-flash|7-|6-|5-))/,
  'opencode-go': /^(gpt-|grok-|muse-spark|claude-|qwen|minimax-)/,
};

/** Drops the models a preset lists but does not serve on /chat/completions. */
export function chatModelsFor<T extends { id: string }>(provider: ApiProviderId, models: readonly T[]): T[] {
  const excluded = NOT_CHAT_COMPLETIONS[provider];
  return excluded ? models.filter((m) => !excluded.test(m.id)) : [...models];
}

/** The base URL to call: the config's own for `custom` (required) or an override, else the preset's. */
export function resolveBaseUrl(id: ApiProviderId, override?: string): string {
  const entry = PROVIDER_REGISTRY[id];
  const chosen = override?.trim() || (entry.requiresBaseUrl ? '' : entry.baseUrl);
  if (!chosen) throw new Error(`Provider ${id} requires a base URL`);
  return chosen.replace(/\/+$/, '');
}

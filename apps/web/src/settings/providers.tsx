import { useQuery } from '@tanstack/react-query';
import { api, type ApiProvider, type CatalogModel, type KeyProvider } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';

/** Every provider the SaaS accepts, in display order (`claude-code` stays Action-only). */
export const SAAS_PROVIDERS: readonly ApiProvider[] = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'deepseek',
  'nvidia',
  'openrouter',
  'opencode-zen',
  'opencode-go',
  'zai',
  'zai-coding',
  'xiaomi',
  'xiaomi-token-plan',
  'xiaomi-token-plan-cn',
  'custom',
];

/** Key types that serve only the Jev judge (ADR-0015): never review providers. */
export const JUDGE_KEY_ONLY_PROVIDERS = ['typesafe', 'vercel-gateway'] as const satisfies readonly KeyProvider[];

export function isJudgeKeyOnly(provider: KeyProvider): provider is (typeof JUDGE_KEY_ONLY_PROVIDERS)[number] {
  return (JUDGE_KEY_ONLY_PROVIDERS as readonly KeyProvider[]).includes(provider);
}

/** Every provider a key can be saved for: the review providers, then the Jev-only key types. */
export const KEY_PROVIDERS: readonly KeyProvider[] = [...SAAS_PROVIDERS, ...JUDGE_KEY_ONLY_PROVIDERS];

const LABEL_KEYS: Record<KeyProvider, I18nKey> = {
  anthropic: 'providerAnthropic',
  openai: 'providerOpenai',
  gemini: 'providerGemini',
  xai: 'providerXai',
  deepseek: 'providerDeepseek',
  nvidia: 'providerNvidia',
  openrouter: 'providerOpenrouter',
  'opencode-zen': 'providerOpencodeZen',
  'opencode-go': 'providerOpencodeGo',
  zai: 'providerZai',
  'zai-coding': 'providerZaiCoding',
  xiaomi: 'providerXiaomi',
  'xiaomi-token-plan': 'providerXiaomiTokenPlan',
  'xiaomi-token-plan-cn': 'providerXiaomiTokenPlanCn',
  custom: 'providerCustom',
  typesafe: 'providerTypesafe',
  'vercel-gateway': 'providerVercelGateway',
};

export const PROVIDER_KEY_HINTS: Partial<Record<ApiProvider, string>> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
  gemini: 'AIza',
  xai: 'xai-',
  deepseek: 'sk-',
  nvidia: 'nvapi-',
  openrouter: 'sk-or-',
  xiaomi: 'sk-',
  'xiaomi-token-plan': 'tp-',
  'xiaomi-token-plan-cn': 'tp-',
};

export function useProviderLabel(): (provider: KeyProvider) => string {
  const { t } = useI18n();
  return (provider) => t(LABEL_KEYS[provider]);
}

export const modelsQueryKey = (workspaceId: string, provider: ApiProvider) =>
  ['workspaces', workspaceId, 'providers', provider, 'models'] as const;

/** The provider's model list with the workspace's stored key (shared by every model select). */
export function useModelsQuery(workspaceId: string, provider: ApiProvider, enabled = true) {
  return useQuery<{ models: CatalogModel[] }>({
    queryKey: modelsQueryKey(workspaceId, provider),
    queryFn: () => api.getModels(workspaceId, provider),
    enabled: enabled && Boolean(workspaceId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** The thinking efforts the chosen model takes (empty when unknown or none). */
export function useModelEfforts(workspaceId: string, provider: ApiProvider, model: string | null | undefined): string[] {
  const { data } = useModelsQuery(workspaceId, provider);
  return data?.models.find((m) => m.id === model)?.efforts ?? [];
}

export const fieldClass =
  'w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60';

export const labelClass = 'block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300';

export interface ProviderSelectProps<P extends KeyProvider = ApiProvider> {
  id: string;
  label: string;
  value: P;
  /** Providers to offer (default: the review providers); the current value is always kept in the list. */
  options?: readonly P[] | undefined;
  onChange: (provider: P) => void;
  disabled?: boolean | undefined;
}

export function ProviderSelect<P extends KeyProvider = ApiProvider>({ id, label, value, options, onChange, disabled }: ProviderSelectProps<P>) {
  const providerLabel = useProviderLabel();
  const offered = options ?? (SAAS_PROVIDERS as readonly KeyProvider[] as readonly P[]);
  const list = offered.includes(value) ? offered : [value, ...offered];
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value as P)}
        className={fieldClass}
      >
        {list.map((p) => (
          <option key={p} value={p}>
            {providerLabel(p)}
          </option>
        ))}
      </select>
    </div>
  );
}

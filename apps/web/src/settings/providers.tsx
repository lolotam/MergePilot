import { useQuery } from '@tanstack/react-query';
import { api, type ApiProvider, type CatalogModel } from '../api/client.js';
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

const LABEL_KEYS: Record<ApiProvider, I18nKey> = {
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

export function useProviderLabel(): (provider: ApiProvider) => string {
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

export interface ProviderSelectProps {
  id: string;
  label: string;
  value: ApiProvider;
  /** Providers to offer; the current value is always kept in the list. */
  options?: readonly ApiProvider[] | undefined;
  onChange: (provider: ApiProvider) => void;
  disabled?: boolean | undefined;
}

export function ProviderSelect({ id, label, value, options = SAAS_PROVIDERS, onChange, disabled }: ProviderSelectProps) {
  const providerLabel = useProviderLabel();
  const list = options.includes(value) ? options : [value, ...options];
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value as ApiProvider)}
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

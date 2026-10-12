import { useState } from 'react';
import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';

export interface HeavyModelCardProps {
  workspaceId: string;
  heavyProvider: ApiProvider | null | undefined;
  heavyModel: string | null | undefined;
  heavyEffort: string | null | undefined;
  heavyThresholdLines: number | null | undefined;
  onChange: (updates: {
    heavyProvider: ApiProvider | null;
    heavyModel: string | null;
    heavyEffort: string | null;
    heavyThresholdLines: number | null;
  }) => void;
  disabled?: boolean;
}

const SAAS_PROVIDERS: readonly ApiProvider[] = [
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
  'custom',
] as const;

export function HeavyModelCard({
  workspaceId,
  heavyProvider,
  heavyModel,
  heavyEffort,
  heavyThresholdLines,
  onChange,
  disabled = false,
}: HeavyModelCardProps) {
  const { t } = useI18n();
  const isEnabled = Boolean(heavyModel);
  const [modelEfforts, setModelEfforts] = useState<string[]>([]);

  const getProviderLabel = (p: ApiProvider) => {
    switch (p) {
      case 'anthropic': return t('providerAnthropic') || 'Anthropic';
      case 'openai': return t('providerOpenai') || 'OpenAI';
      case 'gemini': return t('providerGemini') || 'Google Gemini';
      case 'xai': return t('providerXai') || 'xAI';
      case 'deepseek': return t('providerDeepseek') || 'DeepSeek';
      case 'nvidia': return t('providerNvidia') || 'NVIDIA';
      case 'openrouter': return t('providerOpenrouter') || 'OpenRouter';
      case 'opencode-zen': return t('providerOpencodeZen') || 'OpenCode Zen';
      case 'opencode-go': return t('providerOpencodeGo') || 'OpenCode Go';
      case 'zai': return t('providerZai') || 'Z.ai';
      case 'zai-coding': return t('providerZaiCoding') || 'Z.ai GLM Coding';
      case 'custom': return t('providerCustom') || 'Custom';
      default: return p;
    }
  };

  const currentProvider: ApiProvider = heavyProvider || 'anthropic';

  const handleToggle = (checked: boolean) => {
    if (checked) {
      onChange({
        heavyProvider: 'anthropic',
        heavyModel: 'claude-3-7-sonnet',
        heavyEffort: null,
        heavyThresholdLines: 800,
      });
    } else {
      onChange({
        heavyProvider: null,
        heavyModel: null,
        heavyEffort: null,
        heavyThresholdLines: null,
      });
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-3xl shadow-xs flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('heavyModelCardTitle')}
          </h3>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
            {t('heavyModelCardDesc')}
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            disabled={disabled}
            checked={isEnabled}
            onChange={(e) => handleToggle(e.target.checked)}
            className="w-4 h-4 rounded text-brand-600 focus:ring-brand-500 border-ink-300 dark:border-ink-700"
          />
          <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">
            {t('heavyModelEnabled')}
          </span>
        </label>
      </div>

      {isEnabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-ink-100 dark:border-ink-800">
          <div>
            <label className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
              {t('heavyProviderLabel')}
            </label>
            <select
              disabled={disabled}
              value={currentProvider}
              onChange={(e) => {
                const nextProvider = e.target.value as ApiProvider;
                onChange({
                  heavyProvider: nextProvider,
                  heavyModel: '',
                  heavyEffort: null,
                  heavyThresholdLines: heavyThresholdLines ?? 800,
                });
              }}
              className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {SAAS_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {getProviderLabel(p)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <ModelSelect
              workspaceId={workspaceId}
              provider={currentProvider}
              value={heavyModel || ''}
              disabled={disabled}
              onChange={(model, efforts) => {
                setModelEfforts(efforts);
                onChange({
                  heavyProvider: currentProvider,
                  heavyModel: model,
                  heavyEffort: heavyEffort ?? null,
                  heavyThresholdLines: heavyThresholdLines ?? 800,
                });
              }}
            />
          </div>

          <EffortSelect
            efforts={modelEfforts}
            value={heavyEffort}
            disabled={disabled}
            onChange={(effort) =>
              onChange({
                heavyProvider: currentProvider,
                heavyModel: heavyModel || '',
                heavyEffort: effort,
                heavyThresholdLines: heavyThresholdLines ?? 800,
              })
            }
          />

          <div>
            <label className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
              {t('heavyThresholdLabel')}
            </label>
            <input
              type="number"
              min={1}
              disabled={disabled}
              value={heavyThresholdLines ?? 800}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                onChange({
                  heavyProvider: currentProvider,
                  heavyModel: heavyModel || '',
                  heavyEffort: heavyEffort ?? null,
                  heavyThresholdLines: isNaN(val) ? 800 : val,
                });
              }}
              placeholder={t('heavyThresholdHint')}
              className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            />
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">
              {t('heavyThresholdHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

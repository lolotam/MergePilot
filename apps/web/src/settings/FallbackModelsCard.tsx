import { useState } from 'react';
import type { FallbackEntry } from '@mergepilot/app/contract';
import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';

export interface FallbackModelsCardProps {
  workspaceId: string;
  fallbacks: FallbackEntry[];
  onChange: (fallbacks: FallbackEntry[]) => void;
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

export function FallbackModelsCard({
  workspaceId,
  fallbacks,
  onChange,
  disabled = false,
}: FallbackModelsCardProps) {
  const { t } = useI18n();
  const [effortsMap, setEffortsMap] = useState<Record<number, string[]>>({});

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

  const handleAdd = () => {
    if (fallbacks.length >= 3) return;
    onChange([
      ...fallbacks,
      {
        provider: 'openai',
        model: 'gpt-4o',
        effort: null,
      },
    ]);
  };

  const handleRemove = (index: number) => {
    onChange(fallbacks.filter((_, i) => i !== index));
  };

  const handleMove = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= fallbacks.length) return;
    const next = [...fallbacks];
    const temp = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = temp;
    onChange(next);
  };

  const handleUpdate = (index: number, updates: Partial<FallbackEntry>) => {
    const next = fallbacks.map((f, i) => (i === index ? { ...f, ...updates } : f));
    onChange(next);
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-3xl shadow-xs flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('fallbackCardTitle')}
          </h3>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1 max-w-2xl leading-relaxed">
            {t('fallbackCardDesc')}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || fallbacks.length >= 3}
          onClick={handleAdd}
          className="px-4 py-2 bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/40 dark:hover:bg-brand-950/80 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800 rounded-full text-xs font-semibold disabled:opacity-50 transition-colors shrink-0"
        >
          + {t('addFallbackButton')}
        </button>
      </div>

      {fallbacks.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-2xl">
          {t('noFallbacksConfigured')}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {fallbacks.map((fb, idx) => (
            <div
              key={idx}
              className="p-4 border border-ink-200 dark:border-ink-800 rounded-2xl bg-ink-50/50 dark:bg-ink-950/20 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-ink-800 dark:text-ink-200">
                  {t('fallbackItemPriority', { index: String(idx + 1) })}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={disabled || idx === 0}
                    onClick={() => handleMove(idx, 'up')}
                    className="p-1 text-xs rounded hover:bg-ink-200 dark:hover:bg-ink-700 disabled:opacity-30"
                    title={t('moveUp')}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    disabled={disabled || idx === fallbacks.length - 1}
                    onClick={() => handleMove(idx, 'down')}
                    className="p-1 text-xs rounded hover:bg-ink-200 dark:hover:bg-ink-700 disabled:opacity-30"
                    title={t('moveDown')}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => handleRemove(idx)}
                    className="text-xs text-red-600 hover:text-red-700 ms-2 font-medium"
                  >
                    {t('removeFallback')}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
                    {t('providerLabel')}
                  </label>
                  <select
                    disabled={disabled}
                    value={fb.provider}
                    onChange={(e) => {
                      setEffortsMap((prev) => ({ ...prev, [idx]: [] }));
                      handleUpdate(idx, {
                        provider: e.target.value as ApiProvider,
                        model: '',
                        effort: null,
                      });
                    }}
                    className="w-full px-3.5 py-1.5 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
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
                    provider={fb.provider as ApiProvider}
                    value={fb.model}
                    disabled={disabled}
                    onChange={(model, efforts) => {
                      setEffortsMap((prev) => ({ ...prev, [idx]: efforts }));
                      handleUpdate(idx, { model });
                    }}
                  />
                </div>

                <div>
                  <EffortSelect
                    efforts={effortsMap[idx] || []}
                    value={fb.effort}
                    disabled={disabled}
                    onChange={(effort) => handleUpdate(idx, { effort })}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

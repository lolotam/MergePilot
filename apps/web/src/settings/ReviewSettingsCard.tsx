import { useState, useEffect } from 'react';
import { Sliders } from 'lucide-react';
import type { Settings, FallbackEntry, Severity } from '@mergepilot/app/contract';
import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';
import { SeveritySelect } from './SeveritySelect.js';
import { HeavyModelCard } from './HeavyModelCard.js';
import { FallbackModelsCard } from './FallbackModelsCard.js';

export interface ReviewSettingsCardProps {
  workspaceId: string;
  settings: Settings | null | undefined;
  isLoading: boolean;
  isMember: boolean;
  onSave: (settings: Settings) => Promise<void>;
  isSaving: boolean;
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

export function ReviewSettingsCard({
  workspaceId,
  settings,
  isLoading,
  isMember,
  onSave,
  isSaving,
}: ReviewSettingsCardProps) {
  const { t } = useI18n();

  const [provider, setProvider] = useState<ApiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string | null>(null);
  const [heavyProvider, setHeavyProvider] = useState<ApiProvider | null>(null);
  const [heavyModel, setHeavyModel] = useState<string | null>(null);
  const [heavyEffort, setHeavyEffort] = useState<string | null>(null);
  const [heavyThresholdLines, setHeavyThresholdLines] = useState<number | null>(800);
  const [fallback, setFallback] = useState<FallbackEntry[]>([]);
  const [minSeverity, setMinSeverity] = useState<Severity>('medium');
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [monthlyBudget, setMonthlyBudget] = useState('');
  const [modelEfforts, setModelEfforts] = useState<string[]>([]);

  const [modelError, setModelError] = useState('');
  const [budgetError, setBudgetError] = useState('');

  useEffect(() => {
    if (settings) {
      setProvider(settings.provider);
      setModel(settings.model);
      setEffort(settings.effort ?? null);
      setHeavyProvider(settings.heavyProvider ?? null);
      setHeavyModel(settings.heavyModel ?? null);
      setHeavyEffort(settings.heavyEffort ?? null);
      setHeavyThresholdLines(settings.heavyThresholdLines ?? 800);
      setFallback(settings.fallback ?? []);
      setMinSeverity(settings.minSeverity ?? 'medium');
      setLanguage(settings.language);
      setMonthlyBudget(
        settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined
          ? String(settings.monthlyBudgetUsd)
          : '',
      );
    }
  }, [settings]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMember) return;

    let hasError = false;
    setModelError('');
    setBudgetError('');

    if (!model.trim()) {
      setModelError(t('modelRequired'));
      hasError = true;
    }

    let parsedBudget: number | null = null;
    if (monthlyBudget.trim()) {
      const num = Number(monthlyBudget.trim());
      if (Number.isNaN(num) || num <= 0) {
        setBudgetError(t('budgetMustBePositive'));
        hasError = true;
      } else {
        parsedBudget = num;
      }
    }

    if (hasError) return;

    await onSave({
      provider,
      model: model.trim(),
      language,
      monthlyBudgetUsd: parsedBudget,
      effort: effort || null,
      heavyProvider: heavyModel ? heavyProvider : null,
      heavyModel: heavyModel?.trim() ? heavyModel.trim() : null,
      heavyEffort: heavyModel ? heavyEffort : null,
      heavyThresholdLines: heavyModel ? heavyThresholdLines : null,
      fallback,
      minSeverity,
    });
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Sliders className="w-4 h-4" />
        </div>
        <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('settingsTitle')}</h2>
      </div>

      {isLoading ? (
        <div className="py-4 text-sm text-ink-400">{t('loading')}</div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Main Provider & Model Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="settings-provider" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                {t('providerLabel')}
              </label>
              <select
                id="settings-provider"
                disabled={isMember}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as ApiProvider);
                  setModelEfforts([]);
                }}
                className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
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
                provider={provider}
                value={model}
                disabled={isMember}
                onChange={(m, eff) => {
                  setModel(m);
                  setModelEfforts(eff);
                  if (modelError) setModelError('');
                }}
              />
              {modelError && <p className="text-xs text-red-500 mt-1 ms-2">{modelError}</p>}
            </div>

            <EffortSelect
              efforts={modelEfforts}
              value={effort}
              onChange={setEffort}
              disabled={isMember}
            />

            <SeveritySelect
              value={minSeverity}
              onChange={setMinSeverity}
              disabled={isMember}
            />

            <div>
              <label htmlFor="settings-language" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                {t('languageLabel')}
              </label>
              <select
                id="settings-language"
                disabled={isMember}
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
                className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
              >
                <option value="ar">{t('langArabic')}</option>
                <option value="en">{t('langEnglish')}</option>
              </select>
            </div>

            <div>
              <label htmlFor="settings-budget" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                {t('budgetLabel')}
              </label>
              <input
                id="settings-budget"
                type="text"
                disabled={isMember}
                value={monthlyBudget}
                onChange={(e) => {
                  setMonthlyBudget(e.target.value);
                  if (budgetError) setBudgetError('');
                }}
                placeholder={t('budgetPlaceholder')}
                className={`w-full px-3.5 py-2 rounded-full border text-xs focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
                  budgetError
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
                }`}
              />
              {budgetError && <p className="text-xs text-red-500 mt-1 ms-2">{budgetError}</p>}
            </div>
          </div>

          {/* Heavy-duty Model Section */}
          <HeavyModelCard
            workspaceId={workspaceId}
            heavyProvider={heavyProvider}
            heavyModel={heavyModel}
            heavyEffort={heavyEffort}
            heavyThresholdLines={heavyThresholdLines}
            onChange={(updates) => {
              setHeavyProvider(updates.heavyProvider);
              setHeavyModel(updates.heavyModel);
              setHeavyEffort(updates.heavyEffort);
              setHeavyThresholdLines(updates.heavyThresholdLines);
            }}
            disabled={isMember}
          />

          {/* Fallback Models Section */}
          <FallbackModelsCard
            workspaceId={workspaceId}
            fallbacks={fallback}
            onChange={setFallback}
            disabled={isMember}
          />

          {!isMember && (
            <div className="flex justify-end pt-2 border-t border-ink-100 dark:border-ink-800">
              <button
                type="submit"
                disabled={isSaving}
                className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-full text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
              >
                {isSaving ? t('saving') : t('saveSettingsButton')}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

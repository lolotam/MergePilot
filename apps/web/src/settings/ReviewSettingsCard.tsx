import { useEffect, useRef, useState } from 'react';
import { Sliders } from 'lucide-react';
import type { FallbackEntry, Settings, Severity } from '@mergepilot/app/contract';
import type { BotLogo } from '../api/bots.js';
import { ApiClientError, type ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { EffortSelect, effortFor } from './EffortSelect.js';
import { FallbackModelsCard } from './FallbackModelsCard.js';
import { HeavyModelCard, type HeavyModelValue } from './HeavyModelCard.js';
import { DEFAULT_MAX_FINDINGS, MaxFindingsSelect, type MaxFindings } from './MaxFindingsSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { fieldClass, labelClass, ProviderSelect, useModelEfforts } from './providers.js';
import { SeveritySelect } from './SeveritySelect.js';
import { BotIdentityFields } from './bots/BotIdentityFields.js';
import { botNameError, MAIN_BOT_DEFAULT_LOGO, MAIN_BOT_DEFAULT_NAME } from './bots/BotLogo.js';

export interface ReviewSettingsCardProps {
  workspaceId: string;
  settings: Settings | null | undefined;
  isLoading: boolean;
  isMember: boolean;
  onSave: (settings: Settings) => Promise<void>;
  isSaving: boolean;
  /** Providers with a saved key; heavy and fallback models may only use these. Undefined = unknown. */
  keyedProviders?: readonly ApiProvider[] | undefined;
}

type FormErrors = Partial<Record<'botName' | 'model' | 'budget' | 'heavy' | 'fallback', string>>;

const NO_HEAVY: HeavyModelValue = { heavyProvider: null, heavyModel: null, heavyEffort: null, heavyThresholdLines: null };

function withoutError(errors: FormErrors, field: keyof FormErrors): FormErrors {
  const { [field]: _removed, ...rest } = errors;
  return rest;
}

export function ReviewSettingsCard({
  workspaceId,
  settings,
  isLoading,
  isMember,
  onSave,
  isSaving,
  keyedProviders,
}: ReviewSettingsCardProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<ApiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string | null>(null);
  const [heavy, setHeavy] = useState<HeavyModelValue>(NO_HEAVY);
  const [fallback, setFallback] = useState<FallbackEntry[]>([]);
  const [minSeverity, setMinSeverity] = useState<Severity>('medium');
  const [maxFindings, setMaxFindings] = useState<MaxFindings>(DEFAULT_MAX_FINDINGS);
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [monthlyBudget, setMonthlyBudget] = useState('');
  // The main bot's identity (ADR-0017), saved with the settings.
  const [botName, setBotName] = useState(MAIN_BOT_DEFAULT_NAME);
  const [botLogo, setBotLogo] = useState<BotLogo>(MAIN_BOT_DEFAULT_LOGO);
  const [errors, setErrors] = useState<FormErrors>({});
  const efforts = useModelEfforts(workspaceId, provider, model);
  // The heavy model starts on the main provider when it has a key, else on the first keyed one.
  const heavyDefault: ApiProvider =
    keyedProviders && !keyedProviders.includes(provider) ? (keyedProviders[0] ?? provider) : provider;

  // Refill the form only when a field it shows changed on the server: a patch to another part of
  // the settings (panel output, retention, judge…) must not discard unsaved edits here.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const key = JSON.stringify([
      settings.botName, settings.botLogo, settings.provider, settings.model, settings.effort, settings.heavyProvider,
      settings.heavyModel, settings.heavyEffort, settings.heavyThresholdLines, settings.fallback, settings.minSeverity,
      settings.maxFindings, settings.language, settings.monthlyBudgetUsd,
    ]);
    if (key === shownKey.current) return;
    shownKey.current = key;
    setBotName(settings.botName ?? MAIN_BOT_DEFAULT_NAME);
    setBotLogo(settings.botLogo ?? MAIN_BOT_DEFAULT_LOGO);
    setProvider(settings.provider);
    setModel(settings.model);
    setEffort(settings.effort ?? null);
    setHeavy(
      settings.heavyProvider && settings.heavyModel
        ? {
            heavyProvider: settings.heavyProvider,
            heavyModel: settings.heavyModel,
            heavyEffort: settings.heavyEffort ?? null,
            heavyThresholdLines: settings.heavyThresholdLines ?? null,
          }
        : NO_HEAVY,
    );
    setFallback(settings.fallback ?? []);
    setMinSeverity(settings.minSeverity ?? 'medium');
    setMaxFindings(settings.maxFindings ?? DEFAULT_MAX_FINDINGS);
    setLanguage(settings.language);
    setMonthlyBudget(
      settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined ? String(settings.monthlyBudgetUsd) : '',
    );
  }, [settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMember) return;
    const next: FormErrors = {};
    const nameProblem = botNameError(botName);
    if (nameProblem) next.botName = t(nameProblem);
    if (!model.trim()) next.model = t('modelRequired');
    let parsedBudget: number | null = null;
    if (monthlyBudget.trim()) {
      const num = Number(monthlyBudget.trim());
      if (Number.isNaN(num) || num <= 0) next.budget = t('budgetMustBePositive');
      else parsedBudget = num;
    }
    if (heavy.heavyProvider && !heavy.heavyModel?.trim()) next.heavy = t('heavyModelRequired');
    if (fallback.some((f) => !f.model.trim())) next.fallback = t('fallbackModelRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const heavyOn = Boolean(heavy.heavyProvider && heavy.heavyModel);
    try {
      await onSave({
        provider,
        model: model.trim(),
        language,
        monthlyBudgetUsd: parsedBudget,
        effort,
        heavyProvider: heavyOn ? heavy.heavyProvider : null,
        heavyModel: heavyOn ? (heavy.heavyModel?.trim() ?? null) : null,
        heavyEffort: heavyOn ? heavy.heavyEffort : null,
        heavyThresholdLines: heavyOn ? heavy.heavyThresholdLines : null,
        fallback: fallback.map((f) => ({ provider: f.provider, model: f.model.trim(), effort: f.effort ?? null })),
        minSeverity,
        maxFindings,
        botName: botName.trim(),
        botLogo,
      });
    } catch (err) {
      // A taken bot name is shown on the field; other errors were already shown as a toast.
      if (err instanceof ApiClientError && err.code === 'bot_name_taken') setErrors({ botName: t('botNameTaken') });
    }
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
          <BotIdentityFields
            idPrefix="main-bot"
            name={botName}
            onNameChange={(next) => {
              setBotName(next);
              if (errors.botName) setErrors(withoutError(errors, 'botName'));
            }}
            logo={botLogo}
            onLogoChange={setBotLogo}
            active
            disabled={isMember}
            nameError={errors.botName}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ProviderSelect
              id="settings-provider"
              label={t('providerLabel')}
              value={provider}
              disabled={isMember}
              onChange={(next) => {
                setProvider(next);
                setModel('');
                setEffort(null);
              }}
            />
            <div>
              <ModelSelect
                id="settings-model"
                workspaceId={workspaceId}
                provider={provider}
                value={model}
                disabled={isMember}
                onChange={(m, modelEfforts) => {
                  setModel(m);
                  setEffort((current) => effortFor(modelEfforts, current));
                  if (errors.model) setErrors(withoutError(errors, 'model'));
                }}
              />
              {errors.model && <p className="text-xs text-red-500 mt-1 ms-2">{errors.model}</p>}
            </div>

            <EffortSelect id="settings-effort" efforts={efforts} value={effort} onChange={setEffort} disabled={isMember} />
            <SeveritySelect value={minSeverity} onChange={setMinSeverity} disabled={isMember} />
            <MaxFindingsSelect value={maxFindings} onChange={setMaxFindings} disabled={isMember} />

            <div>
              <label htmlFor="settings-language" className={labelClass}>
                {t('languageLabel')}
              </label>
              <select
                id="settings-language"
                disabled={isMember}
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
                className={fieldClass}
              >
                <option value="ar">{t('langArabic')}</option>
                <option value="en">{t('langEnglish')}</option>
              </select>
            </div>

            <div>
              <label htmlFor="settings-budget" className={labelClass}>
                {t('budgetLabel')}
              </label>
              <input
                id="settings-budget"
                type="text"
                inputMode="decimal"
                disabled={isMember}
                value={monthlyBudget}
                onChange={(e) => {
                  setMonthlyBudget(e.target.value);
                  if (errors.budget) setErrors(withoutError(errors, 'budget'));
                }}
                placeholder={t('budgetPlaceholder')}
                className={errors.budget ? `${fieldClass} border-red-500 focus:ring-red-500` : fieldClass}
              />
              {errors.budget && <p className="text-xs text-red-500 mt-1 ms-2">{errors.budget}</p>}
            </div>
          </div>

          <HeavyModelCard
            workspaceId={workspaceId}
            value={heavy}
            onChange={(next) => {
              setHeavy(next);
              if (errors.heavy) setErrors(withoutError(errors, 'heavy'));
            }}
            providers={keyedProviders}
            defaultProvider={heavyDefault}
            disabled={isMember}
            error={errors.heavy}
          />

          <FallbackModelsCard
            workspaceId={workspaceId}
            fallbacks={fallback}
            onChange={(next) => {
              setFallback(next);
              if (errors.fallback) setErrors(withoutError(errors, 'fallback'));
            }}
            providers={keyedProviders}
            disabled={isMember}
            error={errors.fallback}
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

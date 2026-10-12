import { useEffect, useMemo, useState } from 'react';
import { Gavel, Plus, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { JudgeProvider, JudgeSettings } from '@mergepilot/app/contract';
import { api, type JudgeProvidersResponse, type KeyProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { JudgeTestButton } from './JudgeTestButton.js';
import { fieldClass, labelClass, ProviderSelect } from './providers.js';
import { usePatchSettings, useWorkspaceSettings } from './useSettingsPatch.js';

export const MAX_JUDGE_FALLBACKS = 3;
type Catalog = JudgeProvidersResponse['providers'];

export interface JudgeCardProps {
  workspaceId: string;
  isMember: boolean;
  /** Providers with a saved key; undefined (members) = not known. */
  keyedProviders?: readonly KeyProvider[] | undefined;
}

const modelsOf = (catalog: Catalog, provider: JudgeProvider): string[] =>
  catalog.find((p) => p.id === provider)?.models ?? [];

function defaults(catalog: Catalog, keyed: readonly KeyProvider[] | undefined): JudgeSettings {
  const first = catalog.find((p) => !keyed || keyed.includes(p.id)) ?? catalog[0];
  const provider: JudgeProvider = first?.id ?? 'typesafe';
  return { enabled: false, provider, model: first?.models[0] ?? '', mode: 'off', threshold: 0.35, fallback: [] };
}

interface JevModelSelectProps {
  id: string;
  label: string;
  models: string[];
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}

/** Only the provider's Jev models are offered (owner's rule). */
function JevModelSelect({ id, label, models, value, disabled, onChange }: JevModelSelectProps) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={fieldClass} dir="ltr">
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}

/** «الحَكَم (Jev)» — the judge, its mode and threshold, and up to three fallbacks (ADR-0015). */
export function JudgeCard({ workspaceId, isMember, keyedProviders }: JudgeCardProps) {
  const { t } = useI18n();
  const settings = useWorkspaceSettings(workspaceId).data?.settings;
  const catalogQuery = useQuery({
    queryKey: ['workspaces', workspaceId, 'judge', 'providers'],
    queryFn: () => api.getJudgeProviders(workspaceId),
    enabled: Boolean(workspaceId),
    staleTime: Infinity,
  });
  const catalog = useMemo(() => catalogQuery.data?.providers ?? [], [catalogQuery.data]);
  const patch = usePatchSettings(workspaceId, 'judgeSaved');
  const stored = settings?.judge ?? null;
  const [draft, setDraft] = useState<JudgeSettings | null>(null);

  // The form follows the stored judge until it is edited (and again after a save).
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    setDraft(null);
  }, [storedKey]);
  // Nothing is shown until the Jev model table arrives, so every select lists only Jev models.
  const value = catalog.length === 0 ? null : (draft ?? stored ?? defaults(catalog, keyedProviders));

  // Jev-only key types are always offered; other providers once their key is saved.
  const offered = catalog
    .filter((p) => p.keyOnly || !keyedProviders || keyedProviders.includes(p.id))
    .map((p) => p.id);
  const disabled = isMember || !settings || patch.isPending || !value;
  const update = (next: Partial<JudgeSettings>) => value && setDraft({ ...value, ...next });
  const missingKey = value && keyedProviders && !keyedProviders.includes(value.provider);

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Gavel className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('judgeCardTitle')}</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('judgeCardDesc')}</p>
        </div>
      </div>

      {!value ? (
        <div className="text-sm text-ink-400">{t('loading')}</div>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink-800 dark:text-ink-200">
            <input
              type="checkbox"
              checked={value.enabled}
              disabled={disabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="w-4 h-4 accent-brand-600"
            />
            {t('judgeEnabled')}
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ProviderSelect<JudgeProvider>
              id="judge-provider"
              label={t('judgeProviderLabel')}
              value={value.provider}
              options={offered}
              disabled={disabled}
              onChange={(provider) => update({ provider, model: modelsOf(catalog, provider)[0] ?? '' })}
            />
            <JevModelSelect
              id="judge-model"
              label={t('judgeModelLabel')}
              models={modelsOf(catalog, value.provider)}
              value={value.model}
              disabled={disabled}
              onChange={(model) => update({ model })}
            />
            <div>
              <label htmlFor="judge-mode" className={labelClass}>
                {t('judgeModeLabel')}
              </label>
              <select
                id="judge-mode"
                value={value.mode}
                disabled={disabled}
                onChange={(e) => update({ mode: e.target.value as JudgeSettings['mode'] })}
                className={fieldClass}
              >
                <option value="off">{t('judgeModeOff')}</option>
                <option value="annotate">{t('judgeModeAnnotate')}</option>
                <option value="filter">{t('judgeModeFilter')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="judge-threshold" className={labelClass}>
                {t('judgeThresholdLabel')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  aria-hidden="true"
                  tabIndex={-1}
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.threshold}
                  disabled={disabled}
                  onChange={(e) => update({ threshold: Number(e.target.value) })}
                  className="flex-1 accent-brand-600"
                />
                <input
                  id="judge-threshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.threshold}
                  disabled={disabled}
                  onChange={(e) => update({ threshold: Math.min(1, Math.max(0, Number(e.target.value))) })}
                  className={`${fieldClass} w-24`}
                  dir="ltr"
                />
              </div>
              <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('judgeThresholdHint')}</p>
            </div>
          </div>
          {missingKey ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('judgeNoKey')}</p> : null}

          <div className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-bold text-ink-900 dark:text-ink-100">{t('judgeFallbackTitle')}</h3>
              <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('judgeFallbackDesc')}</p>
            </div>
            <ol className="flex flex-col gap-3">
              {value.fallback.map((entry, index) => (
                <li
                  key={index}
                  className="p-4 border border-ink-200 dark:border-ink-800 rounded-2xl bg-ink-50/50 dark:bg-ink-950/20 flex flex-col gap-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink-800 dark:text-ink-200">
                      {t('judgeFallbackItem', { index: String(index + 1) })}
                    </span>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => update({ fallback: value.fallback.filter((_, i) => i !== index) })}
                      aria-label={`${t('judgeRemoveFallback')} ${index + 1}`}
                      className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-30 focus:ring-2 focus:ring-red-500 focus:outline-hidden"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <ProviderSelect<JudgeProvider>
                      id={`judge-fallback-${index}-provider`}
                      label={t('judgeProviderLabel')}
                      value={entry.provider}
                      options={offered}
                      disabled={disabled}
                      onChange={(provider) =>
                        update({
                          fallback: value.fallback.map((f, i) => (i === index ? { provider, model: modelsOf(catalog, provider)[0] ?? '' } : f)),
                        })
                      }
                    />
                    <JevModelSelect
                      id={`judge-fallback-${index}-model`}
                      label={t('judgeModelLabel')}
                      models={modelsOf(catalog, entry.provider)}
                      value={entry.model}
                      disabled={disabled}
                      onChange={(model) => update({ fallback: value.fallback.map((f, i) => (i === index ? { ...f, model } : f)) })}
                    />
                  </div>
                </li>
              ))}
            </ol>
            {value.fallback.length < MAX_JUDGE_FALLBACKS ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  const provider = offered[0] ?? value.provider;
                  update({ fallback: [...value.fallback, { provider, model: modelsOf(catalog, provider)[0] ?? '' }] });
                }}
                className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-ink-300 dark:border-ink-700 text-xs text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('judgeAddFallback')}
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {!isMember ? <JudgeTestButton workspaceId={workspaceId} provider={value.provider} model={value.model} disabled={disabled} /> : <span />}
            <button
              type="button"
              disabled={disabled || !draft}
              onClick={() => patch.mutate({ judge: value })}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {t('judgeSave')}
            </button>
          </div>
          {!settings ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('retentionNeedsSettings')}</p> : null}
        </div>
      )}
    </div>
  );
}

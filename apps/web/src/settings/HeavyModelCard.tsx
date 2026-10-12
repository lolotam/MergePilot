import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { EffortSelect, effortFor } from './EffortSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { fieldClass, labelClass, ProviderSelect, useModelEfforts } from './providers.js';

export const DEFAULT_HEAVY_THRESHOLD = 800;

export interface HeavyModelValue {
  heavyProvider: ApiProvider | null;
  heavyModel: string | null;
  heavyEffort: string | null;
  heavyThresholdLines: number | null;
}

export interface HeavyModelCardProps {
  workspaceId: string;
  value: HeavyModelValue;
  onChange: (value: HeavyModelValue) => void;
  /** Providers with a saved key (the heavy model needs one); undefined = all. */
  providers?: readonly ApiProvider[] | undefined;
  /** Provider picked when the card is switched on. */
  defaultProvider: ApiProvider;
  disabled?: boolean;
  error?: string | undefined;
}

/** «نموذج المهام الثقيلة»: a stronger model for PRs with at least N changed lines. */
export function HeavyModelCard({
  workspaceId,
  value,
  onChange,
  providers,
  defaultProvider,
  disabled = false,
  error,
}: HeavyModelCardProps) {
  const { t } = useI18n();
  const enabled = value.heavyProvider !== null;
  const provider = value.heavyProvider ?? defaultProvider;
  const efforts = useModelEfforts(workspaceId, provider, value.heavyModel);
  const threshold = value.heavyThresholdLines ?? DEFAULT_HEAVY_THRESHOLD;

  const toggle = (on: boolean) =>
    onChange(
      on
        ? { heavyProvider: defaultProvider, heavyModel: null, heavyEffort: null, heavyThresholdLines: threshold }
        : { heavyProvider: null, heavyModel: null, heavyEffort: null, heavyThresholdLines: null },
    );

  return (
    <section
      aria-labelledby="heavy-model-title"
      className="p-5 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-2xl flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="heavy-model-title" className="text-sm font-bold text-ink-900 dark:text-ink-100">
            {t('heavyModelCardTitle')}
          </h3>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">{t('heavyModelCardDesc')}</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            disabled={disabled}
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            className="w-4 h-4 rounded text-brand-600 focus:ring-brand-500 border-ink-300 dark:border-ink-700"
          />
          <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">{t('heavyModelEnabled')}</span>
        </label>
      </div>

      {enabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-ink-100 dark:border-ink-800">
          <ProviderSelect
            id="heavy-provider"
            label={t('heavyProviderLabel')}
            value={provider}
            options={providers}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, heavyProvider: next, heavyModel: null, heavyEffort: null })}
          />
          <div>
            <ModelSelect
              id="heavy-model"
              label={t('heavyModelLabel')}
              workspaceId={workspaceId}
              provider={provider}
              value={value.heavyModel ?? ''}
              disabled={disabled}
              onChange={(model, modelEfforts) =>
                onChange({
                  ...value,
                  heavyProvider: provider,
                  heavyModel: model || null,
                  heavyEffort: effortFor(modelEfforts, value.heavyEffort),
                })
              }
            />
            {error && <p className="text-xs text-red-500 mt-1 ms-2">{error}</p>}
          </div>
          <EffortSelect
            id="heavy-effort"
            label={t('heavyEffortLabel')}
            efforts={efforts}
            value={value.heavyEffort}
            disabled={disabled}
            onChange={(effort) => onChange({ ...value, heavyEffort: effort })}
          />
          <div>
            <label htmlFor="heavy-threshold" className={labelClass}>
              {t('heavyThresholdLabel')}
            </label>
            <input
              id="heavy-threshold"
              type="number"
              inputMode="numeric"
              min={1}
              disabled={disabled}
              value={threshold}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                onChange({ ...value, heavyThresholdLines: Number.isNaN(n) || n < 1 ? DEFAULT_HEAVY_THRESHOLD : n });
              }}
              className={fieldClass}
            />
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('heavyThresholdHint')}</p>
          </div>
        </div>
      )}
    </section>
  );
}

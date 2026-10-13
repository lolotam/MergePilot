import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { FallbackEntry } from '@mergepilot/app/contract';
import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { EffortSelect, effortFor } from './EffortSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { ProviderSelect, useModelEfforts } from './providers.js';

export const MAX_FALLBACKS = 3;

export interface FallbackModelsCardProps {
  workspaceId: string;
  fallbacks: FallbackEntry[];
  onChange: (fallbacks: FallbackEntry[]) => void;
  /** Providers with a saved key (a fallback needs one); undefined = all. */
  providers?: readonly ApiProvider[] | undefined;
  disabled?: boolean;
  error?: string | undefined;
  /** Element id prefix, unique per page (default `fallback`; an extra bot uses its own). */
  idPrefix?: string;
}

interface RowProps {
  idPrefix: string;
  workspaceId: string;
  index: number;
  count: number;
  entry: FallbackEntry;
  providers?: readonly ApiProvider[] | undefined;
  disabled: boolean;
  onUpdate: (entry: FallbackEntry) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}

const iconButton =
  'p-1.5 rounded-lg text-ink-600 dark:text-ink-300 hover:bg-ink-200 dark:hover:bg-ink-700 disabled:opacity-30 focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

function FallbackRow({ idPrefix, workspaceId, index, count, entry, providers, disabled, onUpdate, onMove, onRemove }: RowProps) {
  const { t } = useI18n();
  const efforts = useModelEfforts(workspaceId, entry.provider, entry.model);
  const prefix = `${idPrefix}-${index}`;
  return (
    <li className="p-4 border border-ink-200 dark:border-ink-800 rounded-2xl bg-ink-50/50 dark:bg-ink-950/20 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink-800 dark:text-ink-200">
          {t('fallbackItemPriority', { index: String(index + 1) })}
        </span>
        <div className="flex items-center gap-1">
          <button type="button" disabled={disabled || index === 0} onClick={() => onMove(-1)} className={iconButton} aria-label={t('moveUp')} title={t('moveUp')}>
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button type="button" disabled={disabled || index === count - 1} onClick={() => onMove(1)} className={iconButton} aria-label={t('moveDown')} title={t('moveDown')}>
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 disabled:opacity-30 focus:ring-2 focus:ring-red-500 focus:outline-hidden"
            aria-label={t('removeFallback')}
            title={t('removeFallback')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ProviderSelect
          id={`${prefix}-provider`}
          label={t('providerLabel')}
          value={entry.provider}
          options={providers}
          disabled={disabled}
          onChange={(provider) => onUpdate({ provider, model: '', effort: null })}
        />
        <ModelSelect
          id={`${prefix}-model`}
          workspaceId={workspaceId}
          provider={entry.provider}
          value={entry.model}
          disabled={disabled}
          onChange={(model, modelEfforts) => onUpdate({ ...entry, model, effort: effortFor(modelEfforts, entry.effort) })}
        />
        <EffortSelect
          id={`${prefix}-effort`}
          efforts={efforts}
          value={entry.effort}
          disabled={disabled}
          onChange={(effort) => onUpdate({ ...entry, effort })}
        />
      </div>
      {entry.provider === 'custom' && <p className="text-[11px] text-ink-500 dark:text-ink-400 ms-1">{t('customSharedUrlHint')}</p>}
    </li>
  );
}

/** «النماذج الاحتياطية»: up to 3 ordered models, used only on disclosed failures (ADR-0008). */
export function FallbackModelsCard({
  workspaceId,
  fallbacks,
  onChange,
  providers,
  disabled = false,
  error,
  idPrefix = 'fallback',
}: FallbackModelsCardProps) {
  const { t } = useI18n();
  const firstProvider = providers?.[0];
  const canAdd = !disabled && fallbacks.length < MAX_FALLBACKS && (providers === undefined || firstProvider !== undefined);

  const add = () => {
    const provider = firstProvider ?? 'anthropic';
    onChange([...fallbacks, { provider, model: '', effort: null }]);
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    const a = fallbacks[index];
    const b = fallbacks[target];
    if (!a || !b) return;
    const next = [...fallbacks];
    next[index] = b;
    next[target] = a;
    onChange(next);
  };

  return (
    <section
      aria-labelledby={`${idPrefix}-title`}
      className="p-5 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-2xl flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${idPrefix}-title`} className="text-sm font-bold text-ink-900 dark:text-ink-100">
            {t('fallbackCardTitle')}
          </h3>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1 max-w-2xl leading-relaxed">{t('fallbackCardDesc')}</p>
        </div>
        <button
          type="button"
          disabled={!canAdd}
          onClick={add}
          title={fallbacks.length >= MAX_FALLBACKS ? t('maxFallbacksReached') : undefined}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/40 dark:hover:bg-brand-950/80 text-brand-700 dark:text-brand-300 border border-brand-200 dark:border-brand-800 rounded-full text-xs font-semibold disabled:opacity-50 transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('addFallbackButton')}
        </button>
      </div>

      {providers !== undefined && providers.length === 0 && !disabled && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('noKeyedProviders')}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {fallbacks.length === 0 ? (
        <div className="py-5 text-center text-xs text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-2xl">
          {t('noFallbacksConfigured')}
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {fallbacks.map((entry, index) => (
            <FallbackRow
              idPrefix={idPrefix}
              key={`${index}-${entry.provider}`}
              workspaceId={workspaceId}
              index={index}
              count={fallbacks.length}
              entry={entry}
              providers={providers}
              disabled={disabled}
              onUpdate={(next) => onChange(fallbacks.map((f, i) => (i === index ? next : f)))}
              onMove={(offset) => move(index, offset)}
              onRemove={() => onChange(fallbacks.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError, type ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { fieldClass, modelsQueryKey, useModelsQuery } from './providers.js';

export interface ModelSelectProps {
  workspaceId: string;
  provider: ApiProvider;
  value: string;
  /** Called when the user picks or types a model, with that model's efforts (empty if unknown). */
  onChange: (model: string, efforts: string[]) => void;
  disabled?: boolean;
  /** Unique per page: several model selects can be on screen at once. */
  id: string;
  label?: string | undefined;
}

const headingClass = 'block text-xs font-semibold text-ink-700 dark:text-ink-300';

/**
 * Searchable model dropdown filled from the provider's live catalog (stored key). Free text is
 * only the fallback when the list cannot be loaded, or when the user asks for it.
 */
export function ModelSelect({ workspaceId, provider, value, onChange, disabled = false, id, label }: ModelSelectProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useModelsQuery(workspaceId, provider);
  const [manualChosen, setManualChosen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const models = useMemo(() => query.data?.models ?? [], [query.data]);
  const isLoading = query.isLoading || refreshing;
  const isManual = manualChosen || query.isError;
  const errorCode = query.error instanceof ApiClientError ? query.error.code : undefined;

  useEffect(() => {
    setManualChosen(false);
    setSearch('');
  }, [provider]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setManualChosen(false);
    try {
      const fresh = await api.getModels(workspaceId, provider, true);
      queryClient.setQueryData(modelsQueryKey(workspaceId, provider), fresh);
    } catch {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, search]);

  const selected = models.find((m) => m.id === value);
  const heading = label ?? t('modelLabel');
  const listId = `${id}-list`;

  const refreshButton = (
    <button
      type="button"
      disabled={disabled || isLoading}
      onClick={() => void refresh()}
      className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline inline-flex items-center gap-1 disabled:opacity-50"
    >
      {isLoading && (
        <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin inline-block" />
      )}
      {t('refreshModelsButton')}
    </button>
  );

  if (isManual) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className={headingClass}>
            {heading}
          </label>
          {refreshButton}
        </div>
        <input
          id={id}
          type="text"
          dir="ltr"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, [])}
          placeholder={t('modelPlaceholder')}
          className={`${fieldClass} font-mono`}
        />
        {query.isError && (
          <p role="status" className="text-[11px] text-amber-600 dark:text-amber-400 ms-2">
            {errorCode === 'key_not_found' ? t('modelsNeedKey') : t('manualModelFallbackHint')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5 relative">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className={headingClass}>
          {heading}
        </label>
        <div className="flex items-center gap-2">
          {refreshButton}
          <span className="text-ink-300 dark:text-ink-700" aria-hidden="true">
            |
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setManualChosen(true)}
            className="text-[11px] text-ink-500 dark:text-ink-400 hover:underline"
          >
            {t('manualModelFallback')}
          </button>
        </div>
      </div>

      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        disabled={disabled || isLoading}
        onClick={() => setIsOpen((prev) => !prev)}
        className={`${fieldClass} text-start flex items-center justify-between`}
      >
        <span className="font-mono truncate">
          {isLoading ? t('loadingModels') : selected ? selected.name || selected.id : value || t('modelPlaceholder')}
        </span>
        <span className="text-ink-400 ms-2" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <div className="absolute top-full mt-1 start-0 end-0 z-30 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-2xl shadow-lg p-2 flex flex-col gap-1">
          <input
            type="search"
            autoFocus
            aria-label={t('searchModelsPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchModelsPlaceholder')}
            className="w-full px-3 py-1.5 rounded-xl border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-xs text-ink-900 dark:text-ink-100 focus:ring-1 focus:ring-brand-500 focus:outline-hidden mb-1"
          />
          <div id={listId} role="listbox" aria-label={heading} className="overflow-y-auto max-h-56 flex flex-col gap-0.5">
            {filtered.length === 0 ? (
              <div className="p-3 text-center text-xs text-ink-500 dark:text-ink-400">{t('noModelsFound')}</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === value}
                  onClick={() => {
                    onChange(m.id, m.efforts);
                    setIsOpen(false);
                    setSearch('');
                  }}
                  className={`w-full text-start px-3 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 hover:bg-brand-50 dark:hover:bg-brand-950/40 ${
                    m.id === value
                      ? 'bg-brand-50/80 dark:bg-brand-950/60 font-semibold text-brand-700 dark:text-brand-300'
                      : 'text-ink-900 dark:text-ink-100'
                  }`}
                >
                  <span className="font-mono truncate" dir="ltr">
                    {m.name || m.id}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import { api, type ApiProvider, type CatalogModel } from '../api/client.js';
import { useI18n } from '../i18n/context.js';

export interface ModelSelectProps {
  workspaceId: string;
  provider: ApiProvider;
  value: string;
  onChange: (model: string, efforts: string[]) => void;
  disabled?: boolean;
  id?: string;
}

export function ModelSelect({
  workspaceId,
  provider,
  value,
  onChange,
  disabled = false,
  id = 'settings-model',
}: ModelSelectProps) {
  const { t } = useI18n();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isManual, setIsManual] = useState(false);
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchModels = async (refresh = false) => {
    if (!workspaceId || !provider) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.getModels(workspaceId, provider, refresh);
      setModels(res.models);
      setIsManual(false);

      // If current value matches a model, notify efforts
      const current = res.models.find((m) => m.id === value);
      if (current) {
        onChange(current.id, current.efforts);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Auto-switch to manual mode on error if no models loaded
      setIsManual(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchModels(false);
  }, [workspaceId, provider]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, search]);

  const selectedModel = models.find((m) => m.id === value);

  if (isManual) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
            {t('modelLabel')}
          </label>
          <button
            type="button"
            disabled={disabled || isLoading}
            onClick={() => {
              setIsManual(false);
              void fetchModels(true);
            }}
            className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline"
          >
            {t('refreshModelsButton')}
          </button>
        </div>
        <input
          id={id}
          aria-label={t('modelLabel')}
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, [])}
          placeholder={t('modelPlaceholder')}
          className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs font-mono text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
        />
        {error && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 ms-2">
            {t('manualModelFallbackHint')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5 relative">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
          {t('modelLabel')}
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled || isLoading}
            onClick={() => void fetchModels(true)}
            className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-1"
          >
            {isLoading && (
              <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin inline-block" />
            )}
            {t('refreshModelsButton')}
          </button>
          <span className="text-ink-300 dark:text-ink-700">|</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setIsManual(true)}
            className="text-[11px] text-ink-500 dark:text-ink-400 hover:underline"
          >
            {t('manualModelFallback')}
          </button>
        </div>
      </div>

      {/* Dropdown trigger */}
      <button
        id={id}
        aria-label={t('modelLabel')}
        type="button"
        disabled={disabled || isLoading}
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-start text-ink-900 dark:text-ink-100 flex items-center justify-between focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      >
        <span className="font-mono truncate">
          {isLoading ? t('loadingModels') : selectedModel ? selectedModel.name || selectedModel.id : value || t('modelPlaceholder')}
        </span>
        <span className="text-ink-400 ms-2">▾</span>
      </button>

      {/* Searchable Popover Menu */}
      {isOpen && (
        <div className="absolute top-full mt-1 start-0 end-0 z-30 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-2xl shadow-lg p-2 max-h-64 flex flex-col gap-1">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchModelsPlaceholder')}
            className="w-full px-3 py-1.5 rounded-xl border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-900 text-xs text-ink-900 dark:text-ink-100 focus:ring-1 focus:ring-brand-500 focus:outline-hidden mb-1"
          />

          <div className="overflow-y-auto max-h-48 flex flex-col gap-0.5">
            {filteredModels.length === 0 ? (
              <div className="p-3 text-center text-xs text-ink-500 dark:text-ink-400">
                {t('noModelsFound')}
              </div>
            ) : (
              filteredModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id, m.efforts);
                    setIsOpen(false);
                    setSearch('');
                  }}
                  className={`w-full text-start px-3 py-1.5 rounded-lg text-xs flex items-center justify-between hover:bg-brand-50 dark:hover:bg-brand-950/40 ${
                    m.id === value
                      ? 'bg-brand-50/80 dark:bg-brand-950/60 font-semibold text-brand-700 dark:text-brand-300'
                      : 'text-ink-900 dark:text-ink-100'
                  }`}
                >
                  <span className="font-mono truncate">{m.name || m.id}</span>
                  {m.efforts.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300 ms-2 shrink-0">
                      efforts: {m.efforts.join(', ')}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

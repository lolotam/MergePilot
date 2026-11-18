import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onCredentialChange } from '../api/credential-queries.js';
import { api, ApiClientError, type KeyProvider } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';
import { isJudgeKeyOnly, modelsQueryKey, useProviderLabel } from './providers.js';

type Result = { label: I18nKey; count?: number };
const queued: Result = { label: 'syncModelsQueued' };
const loading: Result = { label: 'syncModelsLoading' };
const unsupported: Result = { label: 'syncModelsUnsupported' };
const concurrency = 2;

function failureLabel(error: unknown): I18nKey {
  const code = error instanceof ApiClientError ? error.code : undefined;
  if (code === 'catalog_credentials_changed') return 'syncModelsCredentialsChanged';
  if (code === 'provider_unavailable') return 'syncModelsUnavailable';
  if (code === 'key_not_found' || code === 'auth') return 'syncModelsCredentialError';
  if (code === 'quota' || code === 'rate-limit') return 'syncModelsRateError';
  return 'syncModelsError';
}

export function SyncModels({ workspaceId, providers }: { workspaceId: string; providers: readonly KeyProvider[] }) {
  const { t, language } = useI18n();
  const label = useProviderLabel();
  const queryClient = useQueryClient();
  const active = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Partial<Record<KeyProvider, Result>>>({});
  const [lastSuccess, setLastSuccess] = useState<Partial<Record<KeyProvider, number>>>({});
  const connected = [...new Set(providers)];
  const reviewProviders = connected.filter((provider) => !isJudgeKeyOnly(provider));

  const stopSync = useCallback((reason: 'cancelled' | 'credentials-changed') => {
    active.current?.abort();
    active.current = null;
    setRunning(false);
    if (reason === 'credentials-changed') setLastSuccess({});
    setResults((previous) => Object.fromEntries(Object.entries(previous).flatMap(([provider, status]) => {
      if (status === queued || status === loading) {
        const label = reason === 'cancelled' ? 'syncModelsCancelled' : 'syncModelsCredentialsChanged';
        return [[provider, { label }]];
      }
      return reason === 'cancelled' ? [[provider, status]] : [];
    })));
  }, []);

  useLayoutEffect(() => {
    const unsubscribe = onCredentialChange(queryClient, workspaceId, () => stopSync('credentials-changed'));
    return () => {
      unsubscribe();
      active.current?.abort();
      active.current = null;
    };
  }, [queryClient, stopSync, workspaceId]);

  const sync = async () => {
    if (active.current || reviewProviders.length === 0) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setResults(Object.fromEntries(reviewProviders.map((provider) => [provider, queued])));
    const pending = reviewProviders.values();
    const current = () => active.current === controller;

    const worker = async () => {
      while (current()) {
        const next = pending.next();
        if (next.done) return;
        const provider = next.value;
        setResults((previous) => ({ ...previous, [provider]: loading }));
        let result: Result;
        try {
          const fresh = await api.syncModels(workspaceId, provider, controller.signal);
          if (fresh.source !== 'live' && fresh.source !== 'bundled') throw new Error('Missing catalog source');
          if (!current()) return;
          const queryKey = modelsQueryKey(workspaceId, provider);
          // Prevent a pending picker read from overwriting the result with an older catalog.
          await queryClient.cancelQueries({ queryKey, exact: true });
          if (!current()) return;
          queryClient.setQueryData(queryKey, fresh);
          result = { label: fresh.source === 'live' ? 'syncModelsLive' : 'syncModelsBundled', count: fresh.models.length };
          if (fresh.source === 'live') {
            const syncedAt = Date.now();
            setLastSuccess((previous) => ({ ...previous, [provider]: syncedAt }));
          }
        } catch (error) {
          result = { label: failureLabel(error) };
        }
        if (current()) setResults((previous) => ({ ...previous, [provider]: result }));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, reviewProviders.length) }, worker));
    if (current()) {
      active.current = null;
      setRunning(false);
    }
  };

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  const buttonClass = 'px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold disabled:opacity-50';
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={running || reviewProviders.length === 0} onClick={() => void sync()}>
          {t('syncModelsButton')}
        </button>
        {running && <button type="button" className={buttonClass} onClick={() => stopSync('cancelled')}>{t('syncModelsCancel')}</button>}
        {reviewProviders.length === 0 && <span className="text-xs text-ink-500">{t('syncModelsEmpty')}</span>}
      </div>
      <div role="status" aria-live="polite" className="text-xs text-ink-700 dark:text-ink-300">
        <ul className="space-y-1">
          {connected.map((provider) => {
            const result = isJudgeKeyOnly(provider) ? unsupported : results[provider];
            if (!result) return null;
            const syncedAt = lastSuccess[provider];
            return (
              <li key={provider} className="flex flex-wrap gap-x-2">
                <span className="font-semibold">{label(provider)}</span>
                <span>{t(result.label, { count: String(result.count ?? 0) })}</span>
                {syncedAt !== undefined && (
                  <span className="text-ink-500 dark:text-ink-400">
                    {t('syncModelsLastSuccess', { time: dateFormat.format(syncedAt) })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

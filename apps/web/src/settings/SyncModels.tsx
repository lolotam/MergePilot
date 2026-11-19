import { useLayoutEffect, useRef, useState } from 'react';
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

export function SyncModels({ workspaceId, providers, rosterUnavailable = false }: {
  workspaceId: string; providers: readonly KeyProvider[]; rosterUnavailable?: boolean;
}) {
  const { t, language } = useI18n();
  const label = useProviderLabel();
  const queryClient = useQueryClient();
  const active = useRef<Map<KeyProvider, AbortController> | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Partial<Record<KeyProvider, Result>>>({});
  const [lastSuccess, setLastSuccess] = useState<Partial<Record<KeyProvider, number>>>({});
  const connected = [...new Set(providers)];
  const reviewProviders = connected.filter((provider) => !isJudgeKeyOnly(provider));
  const cancelSync = () => {
    const batch = active.current;
    if (!batch) return;
    for (const controller of batch.values()) controller.abort();
    active.current = null;
    setRunning(false);
    setResults((previous) => {
      const next = { ...previous };
      for (const provider of batch.keys()) next[provider] = { label: 'syncModelsCancelled' };
      return next;
    });
  };

  useLayoutEffect(() => {
    const unsubscribe = onCredentialChange(queryClient, workspaceId, (changed) => {
      const batch = active.current;
      const interrupted = changed.filter((provider) => batch?.has(provider));
      for (const provider of interrupted) {
        batch?.get(provider)?.abort();
        batch?.delete(provider);
      }
      if (batch?.size === 0) {
        active.current = null;
        setRunning(false);
      }
      setResults((previous) => {
        const next = { ...previous };
        for (const provider of changed) delete next[provider];
        for (const provider of interrupted) next[provider] = { label: 'syncModelsCredentialsChanged' };
        return next;
      });
      setLastSuccess((previous) => {
        const next = { ...previous };
        for (const provider of changed) delete next[provider];
        return next;
      });
    });
    return () => {
      unsubscribe();
      for (const controller of active.current?.values() ?? []) controller.abort();
      active.current = null;
    };
  }, [queryClient, workspaceId]);

  const sync = async () => {
    if (rosterUnavailable || active.current || reviewProviders.length === 0) return;
    const batch = new Map(reviewProviders.map((provider) => [provider, new AbortController()]));
    active.current = batch;
    setRunning(true);
    setResults(Object.fromEntries(reviewProviders.map((provider) => [provider, queued])));
    const pending = reviewProviders.values();

    const worker = async () => {
      while (active.current === batch) {
        const next = pending.next();
        if (next.done) return;
        const provider = next.value;
        const controller = batch.get(provider);
        if (!controller) continue;
        const current = () => active.current === batch && batch.get(provider) === controller;
        setResults((previous) => ({ ...previous, [provider]: loading }));
        let result: Result;
        try {
          const fresh = await api.syncModels(workspaceId, provider, controller.signal);
          if (fresh.source !== 'live' && fresh.source !== 'bundled') throw new Error('Missing catalog source');
          if (!current()) continue;
          const queryKey = modelsQueryKey(workspaceId, provider);
          // Prevent a pending picker read from overwriting the result with an older catalog.
          await queryClient.cancelQueries({ queryKey, exact: true });
          if (!current()) continue;
          queryClient.setQueryData(queryKey, fresh);
          result = { label: fresh.source === 'live' ? 'syncModelsLive' : 'syncModelsBundled', count: fresh.models.length };
          if (fresh.source === 'live') {
            const syncedAt = Date.now();
            setLastSuccess((previous) => ({ ...previous, [provider]: syncedAt }));
          }
        } catch (error) {
          result = { label: failureLabel(error) };
        }
        if (current()) {
          batch.delete(provider);
          setResults((previous) => ({ ...previous, [provider]: result }));
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, reviewProviders.length) }, worker));
    if (active.current === batch) {
      active.current = null;
      setRunning(false);
    }
  };

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  const buttonClass = 'px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold disabled:opacity-50';
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={rosterUnavailable || running || reviewProviders.length === 0} onClick={() => void sync()}>
          {t('syncModelsButton')}
        </button>
        {running && <button type="button" className={buttonClass} onClick={cancelSync}>{t('syncModelsCancel')}</button>}
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

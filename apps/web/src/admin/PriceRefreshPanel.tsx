import { RefreshCw, Tags } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { formatCount, formatDateTime } from './format.js';
import { useAdminMaintenanceQuery, useRefreshPricesMutation } from './hooks.js';

/** Overview card: the last model price refresh (ADR-0016), and "Refresh prices now". */
export function PriceRefreshPanel() {
  const { t, language } = useI18n();
  const { data, isLoading, isError } = useAdminMaintenanceQuery();
  const refresh = useRefreshPricesMutation();
  const last = data?.prices?.lastRun ?? null;
  const running = last !== null && last.finishedAt === null;

  let status: string;
  if (isLoading) status = t('loading');
  else if (isError) status = t('adminLoadError');
  else if (!last) status = t('adminPricesNever');
  else if (running) status = t('adminPricesRunning');
  else status = t('adminPricesStored', { n: formatCount(last.deletedCount, language) });

  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <Tags className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-bold text-ink-900 dark:text-ink-100">{t('adminPricesTitle')}</h2>
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('adminPricesDesc')}</p>
            <dl className="mt-2 text-xs flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1.5">
                <dt className="text-ink-500 dark:text-ink-400">{t('adminPricesLastRun')}:</dt>
                <dd className="font-semibold text-ink-900 dark:text-ink-100">
                  {last ? formatDateTime(last.startedAt, language) : '—'}
                </dd>
              </div>
              <div data-testid="prices-status" className="text-ink-700 dark:text-ink-300">
                {status}
              </div>
            </dl>
            {last?.error ? (
              <p role="alert" className="mt-1.5 text-[11px] text-red-700 dark:text-red-300 break-words">
                {t('adminPricesError', { error: last.error })}
              </p>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending || running}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>{t('adminPricesRefreshNow')}</span>
        </button>
      </div>
    </section>
  );
}

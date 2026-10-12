import { History, Play } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { formatCount, formatDateTime } from './format.js';
import { useAdminMaintenanceQuery, useRunRetentionMutation } from './hooks.js';

/** Overview card: the last run of the nightly review history cleanup, and "run now". */
export function RetentionPanel() {
  const { t, language } = useI18n();
  const { data, isLoading, isError } = useAdminMaintenanceQuery();
  const runNow = useRunRetentionMutation();
  const last = data?.retention.lastRun ?? null;
  const running = last !== null && last.finishedAt === null;

  let status: string;
  if (isLoading) status = t('loading');
  else if (isError) status = t('adminLoadError');
  else if (!last) status = t('adminRetentionNever');
  else if (running) status = t('adminRetentionRunning');
  else status = t('adminRetentionDeleted', { n: formatCount(last.deletedCount, language) });

  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <History className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs font-bold text-ink-900 dark:text-ink-100">{t('adminRetentionTitle')}</h2>
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('adminRetentionDesc')}</p>
            <dl className="mt-2 text-xs flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1.5">
                <dt className="text-ink-500 dark:text-ink-400">{t('adminRetentionLastRun')}:</dt>
                <dd className="font-semibold text-ink-900 dark:text-ink-100">
                  {last ? formatDateTime(last.startedAt, language) : '—'}
                </dd>
              </div>
              <div data-testid="retention-status" className="text-ink-700 dark:text-ink-300">{status}</div>
            </dl>
            {last?.error ? (
              <p role="alert" className="mt-1.5 text-[11px] text-red-700 dark:text-red-300 break-words">
                {t('adminRetentionError', { error: last.error })}
              </p>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending || running}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
        >
          <Play className="w-3.5 h-3.5 rtl:-scale-x-100" />
          <span>{t('adminRetentionRunNow')}</span>
        </button>
      </div>
    </section>
  );
}

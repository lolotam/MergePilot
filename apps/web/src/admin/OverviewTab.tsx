import { useI18n } from '../i18n/context.js';
import { formatCount, formatUsd } from './format.js';
import { useAdminOverviewQuery } from './hooks.js';
import { PriceRefreshPanel } from './PriceRefreshPanel.js';
import { RetentionPanel } from './RetentionPanel.js';
import { StatCard, StateMessage, StatusBadge } from './ui.js';

export function OverviewTab() {
  const { t, language } = useI18n();
  const { data, isLoading, isError } = useAdminOverviewQuery();

  if (isLoading) return <StateMessage>{t('loading')}</StateMessage>;
  if (isError || !data) return <StateMessage>{t('adminLoadError')}</StateMessage>;

  const n = (value: number) => formatCount(value, language);
  const statuses = Object.entries(data.reviewRuns.byStatus).sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard label={t('statTotalUsers')} value={n(data.users)} />
        <StatCard label={t('statTotalWorkspaces')} value={n(data.workspaces)} />
        <StatCard
          label={t('statInstallations')}
          value={n(data.installations.linked + data.installations.pending)}
          hint={`${t('statLinked')}: ${n(data.installations.linked)} · ${t('statPending')}: ${n(data.installations.pending)}`}
        />
        <StatCard label={t('statRepositories')} value={n(data.repositories)} />
        <StatCard
          label={t('statReviewRuns')}
          value={n(data.reviewRuns.total)}
          hint={`${t('statLast7Days')}: ${n(data.reviewRuns.last7Days)}`}
        />
        <StatCard
          label={t('statCostUsd')}
          value={formatUsd(data.costUsd.allTime, language)}
          hint={`${t('statLast30Days')}: ${formatUsd(data.costUsd.last30Days, language)}`}
        />
      </div>

      <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5">
        <h2 className="text-xs font-bold text-ink-900 dark:text-ink-100 mb-3">
          {t('runsByStatusTitle')}
        </h2>
        {statuses.length === 0 ? (
          <p className="text-xs text-ink-500 dark:text-ink-400">{t('noRunsYet')}</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {statuses.map(([status, count]) => (
              <li key={status} className="flex items-center gap-2 text-xs">
                <StatusBadge status={status} />
                <span className="font-semibold tabular-nums text-ink-900 dark:text-ink-100">{n(count)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RetentionPanel />
        <PriceRefreshPanel />
      </div>
    </div>
  );
}

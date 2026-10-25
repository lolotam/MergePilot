import { Coins } from 'lucide-react';
import { useApiEquivalentUsageQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';

export function ApiEquivalentCard({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useApiEquivalentUsageQuery(workspaceId);

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Coins className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('apiEquivalentTitle')}</h2>
          <span className="text-xs text-ink-500 dark:text-ink-400">
            {data?.monthStart ? new Date(data.monthStart).toLocaleDateString() : ''}
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-400 py-4">{t('loading')}</div>
      ) : !data ? (
        // Only a failed first load has no data; a failed background refetch keeps the last totals.
        <div role="alert" className="py-4 text-center text-sm text-red-600 dark:text-red-400">{t('error')}</div>
      ) : data.reviews === 0 && data.leftOut === 0 ? (
        <div className="py-4 text-center text-sm text-ink-500 dark:text-ink-400">{t('apiEquivalentEmpty')}</div>
      ) : (
        <div>
          <div className="mb-3">
            <div className="text-xs font-medium text-ink-500 dark:text-ink-400">{t('apiEquivalentMonth')}</div>
            <div className="text-3xl font-extrabold text-ink-900 dark:text-ink-100 tabular-nums">
              ≈ ${data.monthUsd.toFixed(2)}
            </div>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-ink-500 dark:text-ink-400 mb-3">
            <div><dt>{t('apiEquivalentTotal')}</dt><dd className="font-semibold text-ink-800 dark:text-ink-200">${data.totalUsd.toFixed(2)}</dd></div>
            <div><dt>{t('apiEquivalentReviews')}</dt><dd className="font-semibold text-ink-800 dark:text-ink-200">{data.reviews}</dd></div>
            <div><dt>{t('apiEquivalentAverage')}</dt><dd className="font-semibold text-ink-800 dark:text-ink-200">${data.averagePerReviewUsd.toFixed(2)}</dd></div>
          </dl>
          {data.byModel.length > 0 && (
            <div className="overflow-x-auto mt-4">
              <h3 className="text-xs font-semibold text-ink-700 dark:text-ink-300 mb-2">{t('apiEquivalentByModel')}</h3>
              <table className="w-full text-start text-xs">
                <thead>
                  <tr className="border-b border-ink-200 dark:border-ink-800 text-[11px] text-ink-500 dark:text-ink-400">
                    <th className="py-2 px-2 text-start">{t('runProviderModelCol')}</th>
                    <th className="py-2 px-2 text-start">{t('runCostCol')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800/60">
                  {data.byModel.map((entry) => (
                    <tr key={`${entry.provider}:${entry.model}`}>
                      <td className="py-2 px-2">
                        <div className="font-medium">{entry.provider} / {entry.model}</div>
                        <div className="text-[11px] text-ink-400 font-mono">
                          {t('tokensUsage', { input: entry.inputTokens.toLocaleString(), output: entry.outputTokens.toLocaleString() })}
                        </div>
                      </td>
                      <td className="py-2 px-2 font-mono">${entry.usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {!isLoading && data && <p className="text-[11px] text-ink-400 mt-3">{t('apiEquivalentNote')}</p>}
      {!isLoading && data && data.leftOut > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{t('apiEquivalentLeftOut', { count: data.leftOut })}</p>
      )}
    </div>
  );
}

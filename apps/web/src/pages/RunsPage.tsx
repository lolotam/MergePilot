import { useState } from 'react';
import { useParams } from 'react-router';
import {
  ExternalLink,
  CheckCircle2,
  Clock,
  AlertCircle,
  SkipForward,
  Loader2,
  HelpCircle,
} from 'lucide-react';
import { useRunsQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import type { ReviewRun } from '../api/client.js';

export function RunsPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();
  const { data: runsData, isLoading } = useRunsQuery(workspaceId, 100);

  const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null);

  const runs = runsData?.runs ?? [];

  const getStatusBadge = (status: ReviewRun['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{t('statusCompleted')}</span>
          </span>
        );
      case 'running':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{t('statusRunning')}</span>
          </span>
        );
      case 'queued':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
            <Clock className="w-3.5 h-3.5" />
            <span>{t('statusQueued')}</span>
          </span>
        );
      case 'skipped':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-800 dark:bg-ink-800 dark:text-gray-300">
            <SkipForward className="w-3.5 h-3.5" />
            <span>{t('statusSkipped')}</span>
          </span>
        );
      case 'failed':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{t('statusFailed')}</span>
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('runsTitle')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('runsDesc')}</p>
      </div>

      <div className="bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-gray-400">{t('loading')}</div>
        ) : runs.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('noRunsFound')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead className="bg-gray-50/75 dark:bg-ink-800/50 border-b border-gray-200 dark:border-ink-800 text-xs text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="py-3 px-4 text-start">{t('runStatusCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runRepoCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runPrCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runShaCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runCostCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runDateCol')}</th>
                  <th className="py-3 px-4 text-start">{t('runDetailCol')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-ink-800/60">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-gray-50/50 dark:hover:bg-ink-800/40 transition-colors">
                    <td className="py-3 px-4">{getStatusBadge(run.status)}</td>
                    <td className="py-3 px-4 font-medium truncate max-w-[220px]">{run.repoFullName}</td>
                    <td className="py-3 px-4">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline font-mono text-xs font-semibold"
                        title={t('viewPrOnGitHub')}
                      >
                        #{run.pullNumber}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {run.headSha ? run.headSha.substring(0, 7) : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs">
                      {run.costUsd !== null ? `$${run.costUsd.toFixed(4)}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 relative">
                      {run.detail ? (
                        <div className="relative inline-block">
                          <button
                            type="button"
                            onClick={() =>
                              setActiveTooltipId(activeTooltipId === run.id ? null : run.id)
                            }
                            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                            aria-label={t('runDetailCol')}
                          >
                            <HelpCircle className="w-4 h-4" />
                          </button>
                          {activeTooltipId === run.id && (
                            <div className="absolute end-0 bottom-full mb-2 w-64 p-3 bg-ink-900 text-white dark:bg-ink-800 text-xs rounded-lg shadow-xl z-50">
                              <p className="whitespace-pre-wrap">{run.detail}</p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

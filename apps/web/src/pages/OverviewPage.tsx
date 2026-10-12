import { useParams, Link } from 'react-router';
import {
  FolderGit2,
  KeyRound,
  Sliders,
  CheckCircle2,
  Circle,
  ExternalLink,
  ArrowUpRight,
  TrendingUp,
  Activity,
} from 'lucide-react';
import {
  useUsageQuery,
  useRunsQuery,
  useInstallationsQuery,
  useKeysQuery,
  useSettingsQuery,
} from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';

export function OverviewPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();

  const { data: usageData, isLoading: usageLoading } = useUsageQuery(workspaceId);
  const { data: runsData, isLoading: runsLoading } = useRunsQuery(workspaceId, 10);
  const { data: installationsData, isLoading: instLoading } = useInstallationsQuery(workspaceId);
  const { data: keysData, isLoading: keysLoading } = useKeysQuery(workspaceId);
  const { data: settingsData, isLoading: settingsLoading } = useSettingsQuery(workspaceId);

  const hasInstallations = (installationsData?.installations?.length ?? 0) > 0;
  const hasKeys = (keysData?.keys?.length ?? 0) > 0;
  const hasSettings = Boolean(settingsData?.settings?.model);

  const showOnboarding =
    !instLoading && !keysLoading && !settingsLoading && (!hasInstallations || !hasKeys || !hasSettings);

  const monthCost = usageData?.monthCostUsd ?? 0;
  const monthlyBudget = usageData?.monthlyBudgetUsd ?? null;
  const usagePercentage =
    monthlyBudget && monthlyBudget > 0 ? Math.min(100, Math.round((monthCost / monthlyBudget) * 100)) : 0;

  return (
    <div className="flex flex-col gap-8">
      {/* Overview Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('overviewTitle')}
        </h1>
      </div>

      {/* Onboarding Checklist Banner */}
      {showOnboarding && (
        <div className="p-6 rounded-2xl border border-brand-200 dark:border-brand-900 bg-brand-50/60 dark:bg-brand-950/40 shadow-xs">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-brand-900 dark:text-brand-100 flex items-center gap-2">
              <Activity className="w-5 h-5 text-brand-600 dark:text-brand-400" />
              <span>{t('onboardingTitle')}</span>
            </h2>
            <p className="text-sm text-brand-700 dark:text-brand-300 mt-1">{t('onboardingDesc')}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {/* Step 1 */}
            <div
              className={`p-4 rounded-xl border transition-all ${
                hasInstallations
                  ? 'bg-white/80 dark:bg-ink-800/80 border-green-200 dark:border-green-900'
                  : 'bg-white dark:bg-ink-900 border-gray-200 dark:border-ink-800'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span className="font-semibold text-sm">{t('step1Title')}</span>
                </div>
                {hasInstallations ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{t('stepCompleted')}</span>
                  </span>
                ) : (
                  <Circle className="w-3.5 h-3.5 text-gray-400" />
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('step1Desc')}</p>
              {!hasInstallations && (
                <Link
                  to={`/w/${workspaceId}/repos`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
                >
                  <span>{t('step1Action')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>

            {/* Step 2 */}
            <div
              className={`p-4 rounded-xl border transition-all ${
                hasKeys
                  ? 'bg-white/80 dark:bg-ink-800/80 border-green-200 dark:border-green-900'
                  : 'bg-white dark:bg-ink-900 border-gray-200 dark:border-ink-800'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span className="font-semibold text-sm">{t('step2Title')}</span>
                </div>
                {hasKeys ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{t('stepCompleted')}</span>
                  </span>
                ) : (
                  <Circle className="w-3.5 h-3.5 text-gray-400" />
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('step2Desc')}</p>
              {!hasKeys && (
                <Link
                  to={`/w/${workspaceId}/settings`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
                >
                  <span>{t('step2Action')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>

            {/* Step 3 */}
            <div
              className={`p-4 rounded-xl border transition-all ${
                hasSettings
                  ? 'bg-white/80 dark:bg-ink-800/80 border-green-200 dark:border-green-900'
                  : 'bg-white dark:bg-ink-900 border-gray-200 dark:border-ink-800'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span className="font-semibold text-sm">{t('step3Title')}</span>
                </div>
                {hasSettings ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{t('stepCompleted')}</span>
                  </span>
                ) : (
                  <Circle className="w-3.5 h-3.5 text-gray-400" />
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('step3Desc')}</p>
              {!hasSettings && (
                <Link
                  to={`/w/${workspaceId}/settings`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
                >
                  <span>{t('step3Action')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Usage & Quick Links Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Usage this month card */}
        <div className="lg:col-span-2 p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-brand-600 dark:text-brand-400" />
              <span>{t('usageThisMonth')}</span>
            </h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {usageData?.monthStart ? new Date(usageData.monthStart).toLocaleDateString() : ''}
            </span>
          </div>

          {usageLoading ? (
            <div className="text-sm text-gray-400">{t('loading')}</div>
          ) : (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-3xl font-extrabold text-ink-900 dark:text-ink-100">
                  ${monthCost.toFixed(2)}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {t('budget')}: {monthlyBudget ? `$${monthlyBudget.toFixed(2)}` : t('noBudgetSet')}
                </span>
              </div>

              {/* Progress bar */}
              {monthlyBudget && monthlyBudget > 0 ? (
                <div>
                  <div
                    role="progressbar"
                    aria-valuenow={usagePercentage}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="w-full h-3 bg-gray-100 dark:bg-ink-800 rounded-full overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full transition-all ${
                        usagePercentage >= 100
                          ? 'bg-red-500'
                          : usagePercentage >= 80
                            ? 'bg-amber-500'
                            : 'bg-brand-600 dark:bg-brand-500'
                      }`}
                      style={{ width: `${usagePercentage}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
                    <span>{usagePercentage}%</span>
                    <span>100%</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Quick Links Card */}
        <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold mb-4">{t('quickLinks')}</h2>
            <div className="flex flex-col gap-2">
              <Link
                to={`/w/${workspaceId}/repos`}
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-ink-800 text-sm font-medium transition-colors"
              >
                <div className="flex items-center gap-2">
                  <FolderGit2 className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span>{t('navRepos')}</span>
                </div>
                <ArrowUpRight className="w-4 h-4 text-gray-400" />
              </Link>
              <Link
                to={`/w/${workspaceId}/runs`}
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-ink-800 text-sm font-medium transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span>{t('navRuns')}</span>
                </div>
                <ArrowUpRight className="w-4 h-4 text-gray-400" />
              </Link>
              <Link
                to={`/w/${workspaceId}/settings`}
                className="flex items-center justify-between p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-ink-800 text-sm font-medium transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-brand-600 dark:text-brand-400" />
                  <span>{t('navSettings')}</span>
                </div>
                <ArrowUpRight className="w-4 h-4 text-gray-400" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Latest 10 Runs Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">{t('latestRuns')}</h2>
          <Link
            to={`/w/${workspaceId}/runs`}
            className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-1"
          >
            <span>{t('viewAllRuns')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {runsLoading ? (
          <div className="py-8 text-center text-sm text-gray-500">{t('loading')}</div>
        ) : !runsData?.runs || runsData.runs.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('noRunsYet')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-ink-800 text-xs text-gray-500 dark:text-gray-400">
                  <th className="py-2.5 px-3 text-start">{t('runRepoCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runPrCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runStatusCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runCostCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runDateCol')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-ink-800/50">
                {runsData.runs.map((run) => (
                  <tr key={run.id} className="hover:bg-gray-50/50 dark:hover:bg-ink-800/40">
                    <td className="py-2.5 px-3 font-medium truncate max-w-[200px]">{run.repoFullName}</td>
                    <td className="py-2.5 px-3">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline font-mono"
                      >
                        #{run.pullNumber}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                          run.status === 'completed'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                            : run.status === 'running'
                              ? 'bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300'
                              : run.status === 'failed'
                                ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300'
                                : 'bg-gray-100 text-gray-800 dark:bg-ink-800 dark:text-gray-300'
                        }`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs">
                      {run.costUsd !== null ? `$${run.costUsd.toFixed(4)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-gray-500 dark:text-gray-400">
                      {new Date(run.createdAt).toLocaleDateString()}
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

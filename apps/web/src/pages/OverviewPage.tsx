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
  Layers,
} from 'lucide-react';
import {
  useUsageQuery,
  useRunsQuery,
  useInstallationsQuery,
  useKeysQuery,
  useSettingsQuery,
} from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { PageHeader } from '../components/PageHeader.js';
import { ApiEquivalentCard } from './ApiEquivalentCard.js';

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
    <div className="flex flex-col gap-6 max-w-7xl">
      {/* Page Header with Serif Heading */}
      <PageHeader
        title={t('overviewTitle')}
        subtitle={t('onboardingDesc')}
      />

      {/* Onboarding Checklist Banner */}
      {showOnboarding && (
        <div className="p-6 rounded-[10px] border border-brand-200 dark:border-brand-900/60 bg-brand-50/40 dark:bg-brand-950/20 shadow-xs">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
                {t('onboardingTitle')}
              </h2>
              <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('onboardingDesc')}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {/* Step 1 */}
            <div
              className={`p-5 rounded-[10px] border transition-all flex flex-col justify-between ${
                hasInstallations
                  ? 'bg-white dark:bg-ink-900 border-green-200 dark:border-green-900/60'
                  : 'bg-white dark:bg-ink-900 border-ink-200 dark:border-ink-700 shadow-xs'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                    <FolderGit2 className="w-4 h-4" />
                  </div>
                  {hasInstallations ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>{t('stepCompleted')}</span>
                    </span>
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-ink-300 dark:text-ink-600" />
                  )}
                </div>
                <h3 className="font-bold text-sm text-ink-900 dark:text-ink-100 mb-1">{t('step1Title')}</h3>
                <p className="text-xs text-ink-500 dark:text-ink-400 mb-4 leading-relaxed font-sans">{t('step1Desc')}</p>
              </div>

              {!hasInstallations && (
                <Link
                  to={`/w/${workspaceId}/repos`}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold text-ink-800 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
                >
                  <span>{t('step1Action')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>

            {/* Step 2 */}
            <div
              className={`p-5 rounded-[10px] border transition-all flex flex-col justify-between ${
                hasKeys
                  ? 'bg-white dark:bg-ink-900 border-green-200 dark:border-green-900/60'
                  : 'bg-white dark:bg-ink-900 border-ink-200 dark:border-ink-700 shadow-xs'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                    <KeyRound className="w-4 h-4" />
                  </div>
                  {hasKeys ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>{t('stepCompleted')}</span>
                    </span>
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-ink-300 dark:text-ink-600" />
                  )}
                </div>
                <h3 className="font-bold text-sm text-ink-900 dark:text-ink-100 mb-1">{t('step2Title')}</h3>
                <p className="text-xs text-ink-500 dark:text-ink-400 mb-4 leading-relaxed font-sans">{t('step2Desc')}</p>
              </div>

              {!hasKeys && (
                <Link
                  to={`/w/${workspaceId}/settings`}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold text-ink-800 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
                >
                  <span>{t('step2Action')}</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>

            {/* Step 3 */}
            <div
              className={`p-5 rounded-[10px] border transition-all flex flex-col justify-between ${
                hasSettings
                  ? 'bg-white dark:bg-ink-900 border-green-200 dark:border-green-900/60'
                  : 'bg-white dark:bg-ink-900 border-ink-200 dark:border-ink-700 shadow-xs'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                    <Sliders className="w-4 h-4" />
                  </div>
                  {hasSettings ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>{t('stepCompleted')}</span>
                    </span>
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-ink-300 dark:text-ink-600" />
                  )}
                </div>
                <h3 className="font-bold text-sm text-ink-900 dark:text-ink-100 mb-1">{t('step3Title')}</h3>
                <p className="text-xs text-ink-500 dark:text-ink-400 mb-4 leading-relaxed font-sans">{t('step3Desc')}</p>
              </div>

              {!hasSettings && (
                <Link
                  to={`/w/${workspaceId}/settings`}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-4 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold text-ink-800 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
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
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Usage this month card */}
        <div className="lg:col-span-2 p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                <TrendingUp className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
                  {t('usageThisMonth')}
                </h2>
                <span className="text-xs text-ink-500 dark:text-ink-400">
                  {usageData?.monthStart ? new Date(usageData.monthStart).toLocaleDateString() : ''}
                </span>
              </div>
            </div>
          </div>

          {usageLoading ? (
            <div className="text-sm text-ink-400 py-4">{t('loading')}</div>
          ) : (
            <div>
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-3xl font-extrabold text-ink-900 dark:text-ink-100 tabular-nums">
                  ${monthCost.toFixed(2)}
                </span>
                <span className="text-xs font-medium text-ink-500 dark:text-ink-400">
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
                    className="w-full h-2.5 bg-ink-100 dark:bg-ink-800 rounded-full overflow-hidden"
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
                  <div className="flex justify-between text-[11px] text-ink-400 font-mono mt-1.5">
                    <span>{usagePercentage}%</span>
                    <span>100%</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <ApiEquivalentCard workspaceId={workspaceId} />

        {/* Quick Links Card */}
        <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('quickLinks')}</h2>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                to={`/w/${workspaceId}/repos`}
                className="flex items-center justify-between p-2.5 rounded-full hover:bg-ink-50 dark:hover:bg-ink-800 text-xs font-medium transition-colors border border-transparent hover:border-ink-200 dark:hover:border-ink-700"
              >
                <div className="flex items-center gap-2.5 ps-1">
                  <FolderGit2 className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                  <span>{t('navRepos')}</span>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-ink-400 pe-1" />
              </Link>
              <Link
                to={`/w/${workspaceId}/runs`}
                className="flex items-center justify-between p-2.5 rounded-full hover:bg-ink-50 dark:hover:bg-ink-800 text-xs font-medium transition-colors border border-transparent hover:border-ink-200 dark:hover:border-ink-700"
              >
                <div className="flex items-center gap-2.5 ps-1">
                  <Activity className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                  <span>{t('navRuns')}</span>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-ink-400 pe-1" />
              </Link>
              <Link
                to={`/w/${workspaceId}/settings`}
                className="flex items-center justify-between p-2.5 rounded-full hover:bg-ink-50 dark:hover:bg-ink-800 text-xs font-medium transition-colors border border-transparent hover:border-ink-200 dark:hover:border-ink-700"
              >
                <div className="flex items-center gap-2.5 ps-1">
                  <Sliders className="w-4 h-4 text-brand-700 dark:text-brand-400" />
                  <span>{t('navSettings')}</span>
                </div>
                <ArrowUpRight className="w-3.5 h-3.5 text-ink-400 pe-1" />
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Latest 10 Runs Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('latestRuns')}</h2>
          <Link
            to={`/w/${workspaceId}/runs`}
            className="text-xs font-semibold text-brand-700 dark:text-brand-300 hover:underline flex items-center gap-1"
          >
            <span>{t('viewAllRuns')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {runsLoading ? (
          <div className="py-8 text-center text-sm text-ink-400">{t('loading')}</div>
        ) : !runsData?.runs || runsData.runs.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-500 dark:text-ink-400">
            {t('noRunsYet')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-ink-200 dark:border-ink-800 text-[11px] text-ink-500 dark:text-ink-400">
                  <th className="py-2.5 px-3 text-start">{t('runRepoCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runPrCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runStatusCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runCostCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('runDateCol')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800/60">
                {runsData.runs.map((run) => (
                  <tr key={run.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40">
                    <td className="py-2.5 px-3 font-medium truncate max-w-[200px]">{run.repoFullName}</td>
                    <td className="py-2.5 px-3">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300 hover:underline font-mono font-medium"
                      >
                        #{run.pullNumber}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                          run.status === 'completed'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                            : run.status === 'running'
                              ? 'bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300'
                              : run.status === 'failed'
                                ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300'
                                : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300'
                        }`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs">
                      {run.costUsd !== null ? `$${run.costUsd.toFixed(4)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-ink-500 dark:text-ink-400">
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

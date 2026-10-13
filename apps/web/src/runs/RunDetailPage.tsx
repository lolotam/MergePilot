import { useParams, Link } from 'react-router';
import {
  ExternalLink,
  ArrowRight,
  ArrowLeft,
  Clock,
  Coins,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  AlertCircle,
  SkipForward,
  RotateCcw,
} from 'lucide-react';
import { useRunDetailQuery, useMeQuery } from '../api/hooks.js';
import { useRetryRunMutation } from './useRunRetry.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';
import { RunProviderBadge, RunModelBadge } from './RunBadges.js';
import { RunFindingsList } from './RunFindingsList.js';
import { RunDuration } from './RunDuration.js';
import { RunCost } from './RunPriceSource.js';
import type { ReviewRun } from '../api/client.js';

export default function RunDetailPage() {
  const { workspaceId = '', runId = '' } = useParams();
  const { t, language } = useI18n();
  const { data, isLoading, error } = useRunDetailQuery(workspaceId, runId);
  const meQuery = useMeQuery();
  const meData = meQuery?.data;
  const currentWorkspace = meData?.workspaces?.find((w) => w.id === workspaceId);
  const isMember = currentWorkspace?.role === 'member';
  const retryMutation = useRetryRunMutation(workspaceId);

  const run = data?.run;
  const isRtl = language === 'ar';
  const BackArrow = isRtl ? ArrowRight : ArrowLeft;

  if (isLoading) {
    return (
      <div className="py-24 text-center text-sm text-ink-400 flex flex-col items-center gap-2">
        <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        <span>{t('loading')}</span>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 max-w-xl mx-auto text-center">
        <AlertCircle className="w-10 h-10 text-red-500" />
        <h2 className="text-lg font-bold text-ink-900 dark:text-ink-100">{t('runNotFound')}</h2>
        <Link
          to={`/w/${workspaceId}/runs`}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        >
          <BackArrow className="w-4 h-4" />
          <span>{t('backToRuns')}</span>
        </Link>
      </div>
    );
  }

  const result = run.result;

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      {/* Back button & Title */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to={`/w/${workspaceId}/runs`}
            className="p-2 rounded-md border border-ink-200 dark:border-ink-700 hover:bg-ink-100 dark:hover:bg-ink-800 text-ink-600 dark:text-ink-300 transition-colors"
            aria-label={t('backToRuns')}
          >
            <BackArrow className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-semibold text-ink-900 dark:text-ink-100" dir="ltr">
                {run.repoFullName}
              </span>
              <a
                href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs font-bold text-brand-600 dark:text-brand-400 hover:underline"
              >
                #{run.pullNumber}
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <h1 className="text-xl font-bold text-ink-900 dark:text-ink-50 mt-0.5">
              {t('runDetailTitle')}
            </h1>
          </div>
        </div>

        {/* Actions (Retry & GitHub Review link) */}
        <div className="flex items-center gap-2.5">
          {(run.status === 'failed' || run.status === 'skipped') && (
            <button
              type="button"
              disabled={isMember || retryMutation.isPending}
              onClick={() => retryMutation.mutate(run.id)}
              title={isMember ? t('retryMemberDisabled') : t('retry')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors ${
                isMember
                  ? 'opacity-50 cursor-not-allowed bg-ink-100 dark:bg-ink-800 text-ink-400 dark:text-ink-500'
                  : 'bg-brand-600 text-white hover:bg-brand-700 shadow-xs'
              }`}
            >
              <RotateCcw className={`w-3.5 h-3.5 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
              <span>{retryMutation.isPending ? t('retrying') : t('retry')}</span>
            </button>
          )}

          {run.reviewUrl && (
            <a
              href={run.reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-md bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-900 hover:bg-ink-800 dark:hover:bg-white shadow-xs transition-colors"
            >
              <span>{t('openReviewOnGitHub')}</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Overview Metadata Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Status */}
        <div className="p-3.5 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-ink-500">{t('runStatusCol')}</span>
          <div>{getStatusBadge(run.status, t)}</div>
        </div>

        {/* Provider & Model */}
        <div className="p-3.5 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-ink-500">{t('runModelCol')}</span>
          <div className="flex flex-col gap-1">
            <RunProviderBadge provider={run.provider} />
            <RunModelBadge
              model={run.model}
              effort={run.effort}
              fallbackFrom={run.fallbackFrom}
            />
          </div>
        </div>

        {/* Cost & Tokens */}
        <div className="p-3.5 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-ink-500 flex items-center gap-1">
            <Coins className="w-3 h-3 text-ink-400" />
            <span>{t('runCostCol')}</span>
          </span>
          <RunCost costUsd={run.costUsd} pricing={result?.pricing} />
          {result?.usage && (
            <span className="text-[10px] text-ink-400 font-mono" dir="ltr">
              {result.usage.inputTokens.toLocaleString()} in / {result.usage.outputTokens.toLocaleString()} out
            </span>
          )}
        </div>

        {/* Duration & Date */}
        <div className="p-3.5 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-ink-500 flex items-center gap-1">
            <Clock className="w-3 h-3 text-ink-400" />
            <span>{t('duration')}</span>
          </span>
          <div className="text-xs font-semibold text-ink-800 dark:text-ink-200 tabular-nums" data-testid="run-duration">
            <RunDuration run={run} />
          </div>
          <span className="text-[10px] text-ink-400">
            {new Date(run.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Failure detail if failed */}
      {run.status === 'failed' && run.detail && (
        <div className="p-4 bg-red-50 dark:bg-red-950/40 rounded-[10px] border border-red-200 dark:border-red-900/60 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-xs font-bold text-red-900 dark:text-red-200">
              {t('statusFailed')}
            </h3>
            <p className="text-xs text-red-700 dark:text-red-300 mt-1 whitespace-pre-wrap">
              {run.detail}
            </p>
          </div>
        </div>
      )}

      {/* Review Result Content */}
      {result ? (
        <div className="flex flex-col gap-6">
          {/* Summary Card */}
          <div className="p-5 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-4">
            <h2 className="text-sm font-bold text-ink-900 dark:text-ink-100">
              {t('summaryTitle')}
            </h2>

            {/* Highlights bullets */}
            {result.highlights && result.highlights.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-ink-600 dark:text-ink-300">
                  {t('highlightsTitle')}:
                </span>
                <ul className="list-disc list-inside space-y-1 text-xs text-ink-800 dark:text-ink-200 leading-relaxed ps-2">
                  {result.highlights.map((h: string, i: number) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Summary plain text */}
            {result.summary && (
              <div className="text-xs text-ink-700 dark:text-ink-300 whitespace-pre-wrap leading-relaxed">
                {result.summary}
              </div>
            )}

            {/* Verification dropped count */}
            {result.verify && result.verify.dropped > 0 && (
              <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1 rounded-md border border-amber-200 dark:border-amber-900/50">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>
                  {t('droppedFindings').replace('{dropped}', String(result.verify.dropped))}
                </span>
              </div>
            )}
          </div>

          {/* Findings List */}
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-bold text-ink-900 dark:text-ink-100">
              {t('findingsTitle')} ({result.findings.length})
            </h2>
            <RunFindingsList
              findings={result.findings}
              outOfDiff={result.outOfDiff}
            />
          </div>
        </div>
      ) : run.status === 'completed' ? (
        <div className="p-8 text-center bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 text-xs text-ink-500">
          {t('noFindings')}
        </div>
      ) : null}
    </div>
  );
}

function getStatusBadge(status: ReviewRun['status'], t: (key: I18nKey) => string) {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">
          <CheckCircle2 className="w-3 h-3" />
          <span>{t('statusCompleted')}</span>
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{t('statusRunning')}</span>
        </span>
      );
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
          <Clock className="w-3 h-3" />
          <span>{t('statusQueued')}</span>
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300">
          <SkipForward className="w-3 h-3" />
          <span>{t('statusSkipped')}</span>
        </span>
      );
    case 'failed':
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300">
          <AlertCircle className="w-3 h-3" />
          <span>{t('statusFailed')}</span>
        </span>
      );
  }
}

import { useCallback, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import {
  ExternalLink,
  CheckCircle2,
  Clock,
  AlertCircle,
  SkipForward,
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  RotateCcw,
} from 'lucide-react';
import { useRunsQuery, useRunReposQuery, useMeQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import type { ReviewRun } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { RunProviderBadge, RunModelBadge, RunSeverityChips } from '../runs/RunBadges.js';
import { RunsFilterBar } from '../runs/RunsFilterBar.js';
import { RunsPagination } from '../runs/RunsPagination.js';
import { RunActionCell } from '../runs/RunActionCell.js';
import { RetryAllFailedModal } from '../runs/RetryAllFailedModal.js';
import { useRetryRunMutation, useRetryFailedRunsMutation } from '../runs/useRunRetry.js';

const PAGE_SIZE = 25;

export function RunsPage() {
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [retryModalOpen, setRetryModalOpen] = useState(false);

  const meQuery = useMeQuery();
  const meData = meQuery?.data;
  const currentWorkspace = meData?.workspaces?.find((w) => w.id === workspaceId);
  const isMember = currentWorkspace?.role === 'member';
  const canRetry = currentWorkspace ? currentWorkspace.role === 'admin' || currentWorkspace.role === 'owner' : false;

  const retryRunMutation = useRetryRunMutation(workspaceId);
  const retryFailedMutation = useRetryFailedRunsMutation(workspaceId);

  // Read params from URL
  const selectedRepos = searchParams.getAll('repo');
  const selectedStatuses = searchParams.getAll('status');
  const fromDate = searchParams.get('from') || '';
  const toDate = searchParams.get('to') || '';
  const searchQuery = searchParams.get('q') || '';
  const sort = searchParams.get('sort') || 'createdAt';
  const dir = (searchParams.get('dir') as 'asc' | 'desc') || 'desc';
  const offset = Number(searchParams.get('offset') || '0');

  // Queries
  const { data: reposData } = useRunReposQuery(workspaceId);
  const repos = reposData?.repos ?? [];

  const { data: runsData, isLoading } = useRunsQuery(workspaceId, {
    limit: PAGE_SIZE,
    offset,
    repo: selectedRepos.length > 0 ? selectedRepos : undefined,
    status: selectedStatuses.length > 0 ? selectedStatuses : undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
    q: searchQuery || undefined,
    sort,
    dir,
  });

  const runs = runsData?.runs ?? [];
  const total = runsData?.total ?? runs.length;

  const hasActiveFilters =
    selectedRepos.length > 0 ||
    selectedStatuses.length > 0 ||
    Boolean(fromDate) ||
    Boolean(toDate) ||
    Boolean(searchQuery);

  // Helper to update search params
  const updateParams = useCallback(
    (updater: (prev: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          updater(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleSelectRepos = (newRepos: string[]) => {
    updateParams((params) => {
      params.delete('repo');
      for (const r of newRepos) params.append('repo', r);
      params.delete('offset');
    });
  };

  const handleSelectStatuses = (newStatuses: string[]) => {
    updateParams((params) => {
      params.delete('status');
      for (const s of newStatuses) params.append('status', s);
      params.delete('offset');
    });
  };

  const handleDateChange = (from: string, to: string) => {
    updateParams((params) => {
      if (from) params.set('from', from);
      else params.delete('from');
      if (to) params.set('to', to);
      else params.delete('to');
      params.delete('offset');
    });
  };

  const handleSearchChange = (q: string) => {
    updateParams((params) => {
      if (q) params.set('q', q);
      else params.delete('q');
      params.delete('offset');
    });
  };

  const handleClearFilters = () => {
    updateParams((params) => {
      params.delete('repo');
      params.delete('status');
      params.delete('from');
      params.delete('to');
      params.delete('q');
      params.delete('offset');
    });
  };

  const handleSort = (colKey: string) => {
    updateParams((params) => {
      if (sort === colKey) {
        params.set('dir', dir === 'asc' ? 'desc' : 'asc');
      } else {
        params.set('sort', colKey);
        params.set('dir', 'desc');
      }
      params.delete('offset');
    });
  };

  const handlePageChange = (newOffset: number) => {
    updateParams((params) => {
      if (newOffset > 0) params.set('offset', String(newOffset));
      else params.delete('offset');
    });
  };

  const getStatusBadge = (status: ReviewRun['status']) => {
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
  };

  const renderSortHeader = (label: string, colKey: string) => {
    const isSorted = sort === colKey;
    const ariaSort = isSorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';

    return (
      <th scope="col" aria-sort={ariaSort} className="py-3 px-4 text-start font-semibold">
        <button
          type="button"
          onClick={() => handleSort(colKey)}
          className="group inline-flex items-center gap-1.5 hover:text-ink-900 dark:hover:text-ink-100 transition-colors focus:outline-hidden"
        >
          <span>{label}</span>
          {isSorted ? (
            dir === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-brand-600 dark:text-brand-400" />
            ) : (
              <ArrowDown className="w-3 h-3 text-brand-600 dark:text-brand-400" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-ink-300 dark:text-ink-600 opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <PageHeader
        title={t('runsTitle')}
        subtitle={t('runsDesc')}
        action={
          canRetry ? (
            <button
              type="button"
              onClick={() => setRetryModalOpen(true)}
              disabled={retryFailedMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${retryFailedMutation.isPending ? 'animate-spin' : ''}`} />
              <span>{t('retryAllFailed')}</span>
            </button>
          ) : null
        }
      />

      {/* Filter Bar */}
      <RunsFilterBar
        repos={repos}
        selectedRepos={selectedRepos}
        onSelectRepos={handleSelectRepos}
        selectedStatuses={selectedStatuses}
        onSelectStatuses={handleSelectStatuses}
        fromDate={fromDate}
        toDate={toDate}
        onDateChange={handleDateChange}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onClearFilters={handleClearFilters}
        hasActiveFilters={hasActiveFilters}
      />

      {/* Runs Table */}
      <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-ink-400">{t('loading')}</div>
        ) : runs.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-500 dark:text-ink-400">
            {t('noRunsFound')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead className="bg-[#FBFBFA] dark:bg-ink-800/50 border-b border-ink-200 dark:border-ink-700 text-[11px] text-ink-500 dark:text-ink-400">
                <tr>
                  {renderSortHeader(t('runStatusCol'), 'status')}
                  {renderSortHeader(t('runRepoCol'), 'repo')}
                  {renderSortHeader(t('runPrCol'), 'pullNumber')}
                  {renderSortHeader(t('runProviderCol'), 'provider')}
                  {renderSortHeader(t('runModelCol'), 'model')}
                  {renderSortHeader(t('runResultCol'), 'findingsCount')}
                  {renderSortHeader(t('runCostCol'), 'costUsd')}
                  {renderSortHeader(t('runDateCol'), 'createdAt')}
                  <th scope="col" className="py-3 px-4 text-center font-semibold">
                    {t('actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800/60">
                {runs.map((run: ReviewRun) => (
                  <tr
                    key={run.id}
                    tabIndex={0}
                    role="button"
                    onClick={() => navigate(`/w/${workspaceId}/runs/${run.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/w/${workspaceId}/runs/${run.id}`);
                      }
                    }}
                    className="hover:bg-ink-50/60 dark:hover:bg-ink-800/40 transition-colors cursor-pointer focus:outline-hidden focus:bg-ink-50 dark:focus:bg-ink-800/50"
                  >
                    <td className="py-3 px-4">{getStatusBadge(run.status)}</td>
                    <td
                      className="py-3 px-4 font-mono text-xs font-medium text-ink-900 dark:text-ink-100 truncate max-w-[200px]"
                      dir="ltr"
                    >
                      {run.repoFullName}
                    </td>
                    <td className="py-3 px-4">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300 hover:underline font-mono text-xs font-semibold"
                        title={t('viewPrOnGitHub')}
                      >
                        #{run.pullNumber}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-3 px-4">
                      <RunProviderBadge provider={run.provider} />
                    </td>
                    <td className="py-3 px-4">
                      <RunModelBadge
                        model={run.model}
                        effort={run.effort}
                        fallbackFrom={run.fallbackFrom}
                      />
                    </td>
                    <td className="py-3 px-4">
                      <RunSeverityChips
                        status={run.status}
                        findingsCount={run.findingsCount}
                        severityCounts={run.severityCounts}
                        detail={run.detail}
                      />
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-ink-900 dark:text-ink-100">
                      {run.costUsd !== null ? `$${run.costUsd.toFixed(4)}` : '—'}
                    </td>
                    <td className="py-3 px-4 text-xs text-ink-500 dark:text-ink-400 whitespace-nowrap">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                      <RunActionCell
                        run={run}
                        isMember={isMember ?? false}
                        onRetry={(runId) => retryRunMutation.mutate(runId)}
                        isRetrying={retryRunMutation.isPending && retryRunMutation.variables === run.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <RunsPagination
          limit={PAGE_SIZE}
          offset={offset}
          total={total}
          onPageChange={handlePageChange}
        />
      </div>

      <RetryAllFailedModal
        isOpen={retryModalOpen}
        count={runs.filter((r) => r.status === 'failed').length}
        isLoading={retryFailedMutation.isPending}
        onClose={() => setRetryModalOpen(false)}
        onConfirm={() => {
          const body = {
            repo: selectedRepos.length > 0 ? selectedRepos : undefined,
            from: fromDate || undefined,
            to: toDate || undefined,
          };
          retryFailedMutation.mutate(body, { onSettled: () => setRetryModalOpen(false) });
        }}
      />
    </div>
  );
}

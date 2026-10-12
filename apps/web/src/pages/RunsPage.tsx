import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { RotateCcw } from 'lucide-react';
import { useRunGroupsQuery, useRunReposQuery, useMeQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { PageHeader } from '../components/PageHeader.js';
import { RunsFilterBar } from '../runs/RunsFilterBar.js';
import { RunsPagination } from '../runs/RunsPagination.js';
import { RetryAllFailedModal } from '../runs/RetryAllFailedModal.js';
import { RepoLegend } from '../runs/RepoLegend.js';
import { RunsBulkDelete } from '../runs/RunsBulkDelete.js';
import { RunsTable } from '../runs/RunsTable.js';
import { useRetryRunMutation, useRetryFailedRunsMutation } from '../runs/useRunRetry.js';
import { usePatchSettings, useWorkspaceSettings, withRepoColor } from '../settings/useSettingsPatch.js';

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

  const { data: runsData, isLoading } = useRunGroupsQuery(workspaceId, {
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

  const groups = runsData?.groups ?? [];
  const total = runsData?.total ?? groups.length;
  const totalRuns = runsData?.totalRuns ?? 0;
  const canDelete = canRetry;

  // Repository colors: the workspace's choices over the hashed defaults (ADR-0014).
  const { data: settingsData } = useWorkspaceSettings(workspaceId);
  const settings = settingsData?.settings;
  const patchSettings = usePatchSettings(workspaceId, 'repoColorSaved');
  const pageRepos = useMemo(() => [...new Set(groups.map((g) => g.repoFullName))], [groups]);

  // Selection is per result set; expanded PRs are remembered per page (query string).
  const viewKey = searchParams.toString();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  useEffect(() => setSelected(new Set()), [viewKey]);
  const [expandedByView, setExpandedByView] = useState<Record<string, Set<string>>>({});
  const expanded = expandedByView[viewKey] ?? new Set<string>();
  const toggleExpand = (key: string) => {
    setExpandedByView((prev) => {
      const next = new Set(prev[viewKey] ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [viewKey]: next };
    });
  };
  const selectRuns = (ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

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

      {canDelete ? (
        <RunsBulkDelete
          workspaceId={workspaceId}
          selectedIds={[...selected]}
          onClearSelection={() => setSelected(new Set())}
          matchingRuns={totalRuns}
          showMatching={hasActiveFilters}
          filters={{
            repo: selectedRepos.length > 0 ? selectedRepos : undefined,
            status: selectedStatuses.length > 0 ? selectedStatuses : undefined,
            from: fromDate || undefined,
            to: toDate || undefined,
            q: searchQuery || undefined,
          }}
        />
      ) : null}

      <RepoLegend
        repos={pageRepos}
        overrides={settings?.repoColors}
        canEdit={canDelete && Boolean(settings)}
        onPick={(repo, color) => patchSettings.mutate({ repoColors: withRepoColor(settings?.repoColors, repo, color) })}
      />

      {/* Runs Table */}
      <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs overflow-hidden">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-ink-400">{t('loading')}</div>
        ) : groups.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-500 dark:text-ink-400">
            {t('noRunsFound')}
          </div>
        ) : (
          <RunsTable
            groups={groups}
            offset={offset}
            sort={sort}
            dir={dir}
            onSort={handleSort}
            overrides={settings?.repoColors}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            selected={selected}
            onSelect={selectRuns}
            canDelete={canDelete}
            isMember={isMember ?? false}
            onOpenRun={(runId) => navigate(`/w/${workspaceId}/runs/${runId}`)}
            onRetry={(runId) => retryRunMutation.mutate(runId)}
            retryingId={retryRunMutation.isPending ? retryRunMutation.variables : undefined}
          />
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
        workspaceId={workspaceId}
        // Only the repo and date filters: the server retries failed runs, so status/search do not apply.
        filters={{
          repo: selectedRepos.length > 0 ? selectedRepos : undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
        }}
        isLoading={retryFailedMutation.isPending}
        onClose={() => setRetryModalOpen(false)}
        onConfirm={(filters) => {
          retryFailedMutation.mutate(filters, { onSettled: () => setRetryModalOpen(false) });
        }}
      />
    </div>
  );
}

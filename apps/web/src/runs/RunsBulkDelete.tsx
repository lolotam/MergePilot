import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { DeleteRunsFilters, DeleteRunsRequest } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import { DeleteRunsModal } from './DeleteRunsModal.js';
import { useDeleteRunsMutation } from './useDeleteRuns.js';

interface RunsBulkDeleteProps {
  workspaceId: string;
  selectedIds: string[];
  onClearSelection: () => void;
  /** Runs matching the page filters (all statuses, as the server counts them for confirmCount). */
  matchingRuns: number;
  /** The page filters as the URL holds them; unknown statuses are dropped. */
  filters: Omit<DeleteRunsFilters, 'status'> & { status?: string[] | undefined };
  /** Offer "delete all matching" (filters are set). */
  showMatching: boolean;
}

type RunStatus = NonNullable<DeleteRunsFilters['status']>[number];
const RUN_STATUSES: readonly string[] = ['queued', 'running', 'completed', 'skipped', 'failed'] satisfies RunStatus[];
const isRunStatus = (s: string): s is RunStatus => RUN_STATUSES.includes(s);

/** Toolbar (selected / all matching) and the confirm dialog of the bulk delete; admin/owner only. */
export function RunsBulkDelete({ workspaceId, selectedIds, onClearSelection, matchingRuns, filters, showMatching }: RunsBulkDeleteProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState<{ body: DeleteRunsRequest; count: number } | null>(null);
  const mutation = useDeleteRunsMutation(workspaceId, () => {
    setPending(null);
    onClearSelection();
  });

  const selected = selectedIds.length;
  if (selected === 0 && !(showMatching && matchingRuns > 0)) return null;

  const button = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors';
  return (
    <div
      role="toolbar"
      aria-label={t('deleteRunsTitle')}
      className="flex flex-wrap items-center gap-2 px-4 py-2.5 rounded-[10px] border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 shadow-xs"
    >
      {selected > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setPending({ body: { ids: selectedIds }, count: selected })}
            className={`${button} bg-red-600 hover:bg-red-700 text-white`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('deleteSelected', { n: selected })}</span>
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            className={`${button} text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800`}
          >
            <X className="w-3.5 h-3.5" />
            <span>{t('clearSelection')}</span>
          </button>
        </>
      ) : null}
      {showMatching && matchingRuns > 0 ? (
        <button
          type="button"
          onClick={() =>
            setPending({
              body: { filters: { ...filters, status: filters.status?.filter(isRunStatus) }, confirmCount: matchingRuns },
              count: matchingRuns,
            })
          }
          className={`${button} ms-auto border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40`}
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t('deleteAllMatching', { n: matchingRuns })}</span>
        </button>
      ) : null}
      <DeleteRunsModal
        isOpen={pending !== null}
        count={pending?.count ?? 0}
        isLoading={mutation.isPending}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) mutation.mutate(pending.body);
        }}
      />
    </div>
  );
}

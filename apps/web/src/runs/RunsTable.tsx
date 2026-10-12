import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { RunGroup } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';
import { RunGroupRows, type RunRowsContext } from './RunGroupRows.js';
import { isDeletable } from './RunCells.js';
import { repoColor, type RepoColorOverrides } from './repo-colors.js';
import { SelectBox } from './SelectBox.js';

interface RunsTableProps extends RunRowsContext {
  groups: RunGroup[];
  offset: number;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (key: string) => void;
  overrides: RepoColorOverrides | undefined;
  expanded: ReadonlySet<string>;
  onToggleExpand: (groupKey: string) => void;
}

export const groupKey = (g: Pick<RunGroup, 'repoFullName' | 'pullNumber'>) => `${g.repoFullName}#${g.pullNumber}`;

/**
 * The runs table, one row per PR (ADR-0014): `#`, selection, PR, then the run columns. A PR with
 * several runs expands into sub-rows. A reviewer/bot column (multi-bot reviews) will go right
 * after the PR column, telling the sub-rows apart.
 */
export function RunsTable({ groups, offset, sort, dir, onSort, overrides, expanded, onToggleExpand, ...ctx }: RunsTableProps) {
  const { t } = useI18n();
  const pageIds = groups.flatMap((g) => g.runs.filter(isDeletable).map((r) => r.id));
  const pageSelected = pageIds.filter((id) => ctx.selected.has(id)).length;
  // Repo chips show only the repo name, unless two owners on this page share that name.
  const ownersByName = new Map<string, Set<string>>();
  for (const g of groups) {
    const name = g.repoFullName.slice(g.repoFullName.indexOf('/') + 1);
    ownersByName.set(name, (ownersByName.get(name) ?? new Set()).add(g.repoFullName));
  }
  const shortRepo = (repo: string) => (ownersByName.get(repo.slice(repo.indexOf('/') + 1))?.size ?? 0) <= 1;

  const sortHeader = (labelKey: I18nKey, key: string) => {
    const isSorted = sort === key;
    return (
      <th scope="col" aria-sort={isSorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-2.5 px-2 text-start font-semibold leading-tight">
        <button
          type="button"
          onClick={() => onSort(key)}
          className="group inline-flex items-center gap-1.5 hover:text-ink-900 dark:hover:text-ink-100 transition-colors focus:outline-hidden"
        >
          <span>{t(labelKey)}</span>
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
    <div className="overflow-x-auto">
      <table className="w-full text-start text-[11px]">
        <thead className="bg-[#FBFBFA] dark:bg-ink-800/50 border-b border-ink-200 dark:border-ink-700 text-[11px] text-ink-500 dark:text-ink-400">
          <tr>
            <th scope="col" className="py-2.5 px-2 text-start font-semibold">{t('runNumberCol')}</th>
            <th scope="col" className="py-2.5 px-2 text-start">
              <SelectBox
                checked={pageIds.length > 0 && pageSelected === pageIds.length}
                indeterminate={pageSelected > 0}
                disabled={!ctx.canDelete || pageIds.length === 0}
                label={t('selectPage')}
                title={ctx.isMember ? t('selectionMemberDisabled') : undefined}
                onChange={(on) => ctx.onSelect(pageIds, on)}
              />
            </th>
            {sortHeader('runPrCol', 'pullNumber')}
            {sortHeader('runStatusCol', 'status')}
            {sortHeader('runProviderModelCol', 'model')}
            {sortHeader('runResultCol', 'findingsCount')}
            {sortHeader('runTokensInCol', 'inputTokens')}
            {sortHeader('runTokensOutCol', 'outputTokens')}
            {sortHeader('duration', 'duration')}
            {sortHeader('runCostCol', 'costUsd')}
            {sortHeader('runDateCol', 'createdAt')}
            <th scope="col" className="py-2.5 px-2 text-center font-semibold">{t('actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100 dark:divide-ink-800/60">
          {groups.map((group, index) => {
            const key = groupKey(group);
            return (
              <RunGroupRows
                key={key}
                group={group}
                number={offset + index + 1}
                color={repoColor(group.repoFullName, overrides)}
                shortRepo={shortRepo(group.repoFullName)}
                expanded={expanded.has(key)}
                onToggle={() => onToggleExpand(key)}
                {...ctx}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

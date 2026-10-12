import type { ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, ExternalLink } from 'lucide-react';
import type { ReviewRun, RunGroup } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { RunActionCell } from './RunActionCell.js';
import { RunModelBadge, RunProviderBadge, RunSeverityChips } from './RunBadges.js';
import { RunDate, RunStatusBadge, RunTokens, formatCost, isDeletable } from './RunCells.js';
import { RunDuration } from './RunDuration.js';
import { RepoChip } from './RepoColorPicker.js';
import type { RepoColor } from './repo-colors.js';
import { SelectBox } from './SelectBox.js';

export interface RunRowsContext {
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], on: boolean) => void;
  canDelete: boolean;
  isMember: boolean;
  onOpenRun: (runId: string) => void;
  onRetry: (runId: string) => void;
  retryingId: string | undefined;
}

interface RunGroupRowsProps extends RunRowsContext {
  group: RunGroup;
  /** Continuous row number across pages (offset + index + 1). */
  number: number;
  color: RepoColor;
  /** Show only the repo name (false when another owner on the page has a repo with that name). */
  shortRepo: boolean;
  expanded: boolean;
  onToggle: () => void;
}

const td = 'py-2 px-2 align-middle';

function PrLink({ run }: { run: Pick<ReviewRun, 'repoFullName' | 'pullNumber'> }) {
  const { t } = useI18n();
  return (
    <a
      href={`https://github.com/${run.repoFullName}/pull/${run.pullNumber}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300 hover:underline font-mono text-[11px] font-semibold"
      title={t('viewPrOnGitHub')}
    >
      #{run.pullNumber}
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

/** The cells after the PR cell; a sub-row and a single-run row show the run itself. */
function RunDetailCells({ run, ctx }: { run: ReviewRun; ctx: RunRowsContext }) {
  return (
    <>
      <td className={td}><RunStatusBadge status={run.status} /></td>
      <td className={td}>
        <div className="flex flex-col items-start gap-1">
          <RunProviderBadge provider={run.provider} />
          <RunModelBadge model={run.model} effort={run.effort} fallbackFrom={run.fallbackFrom} />
        </div>
      </td>
      <td className={td}>
        <RunSeverityChips status={run.status} findingsCount={run.findingsCount} severityCounts={run.severityCounts} detail={run.detail} />
      </td>
      <td className={`${td} font-mono tabular-nums whitespace-nowrap`}><RunTokens value={run.inputTokens} /></td>
      <td className={`${td} font-mono tabular-nums whitespace-nowrap`}><RunTokens value={run.outputTokens} /></td>
      <td className={`${td} font-mono tabular-nums whitespace-nowrap`} data-testid="run-duration"><RunDuration run={run} /></td>
      <td className={`${td} font-mono text-ink-900 dark:text-ink-100 whitespace-nowrap`}>{formatCost(run.costUsd)}</td>
      <td className={`${td} text-ink-500 dark:text-ink-400 whitespace-nowrap`}><RunDate value={run.createdAt} /></td>
      <td className={`${td} text-center`} onClick={(e) => e.stopPropagation()}>
        <RunActionCell run={run} isMember={ctx.isMember} onRetry={ctx.onRetry} isRetrying={ctx.retryingId === run.id} />
      </td>
    </>
  );
}

function rowClass(color: RepoColor, selected: boolean): string {
  return `${color.strip} ${selected ? 'bg-brand-100/70 dark:bg-brand-900/40' : color.tint} hover:bg-ink-100/70 dark:hover:bg-ink-800/60 transition-colors cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500`;
}

function ClickableRow(props: { label: string; className: string; onActivate: () => void; children: ReactNode; testId: string }) {
  return (
    <tr
      tabIndex={0}
      role="button"
      aria-label={props.label}
      data-testid={props.testId}
      onClick={props.onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onActivate();
        }
      }}
      className={props.className}
    >
      {props.children}
    </tr>
  );
}

export function RunGroupRows({ group, number, color, shortRepo, expanded, onToggle, ...ctx }: RunGroupRowsProps) {
  const { t, dir } = useI18n();
  const latest = group.runs[0];
  if (!latest) return null;
  const pr = `${group.repoFullName}#${group.pullNumber}`;
  const deletableIds = group.runs.filter(isDeletable).map((r) => r.id);
  const selectedCount = deletableIds.filter((id) => ctx.selected.has(id)).length;
  const allSelected = deletableIds.length > 0 && selectedCount === deletableIds.length;
  const selectTitle = ctx.isMember ? t('selectionMemberDisabled') : undefined;
  const multi = group.runs.length > 1;

  const prCell = (
    <td className={`${td} whitespace-nowrap`}>
      <div className="flex items-center gap-1.5">
        {multi ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'collapsePr' : 'expandPr', { pr })}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="p-0.5 rounded text-ink-500 hover:text-ink-900 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : dir === 'rtl' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-[18px]" aria-hidden="true" />
        )}
        {/* Repo on top, PR number (and run count) below: keeps the column narrow. */}
        <div className="flex flex-col items-start gap-1">
          <RepoChip repo={group.repoFullName} color={color} short={shortRepo} />
          <div className="flex items-center gap-1.5">
            <PrLink run={latest} />
            {multi ? (
              <span
                className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300"
                title={t('runGroupCountTitle', { n: group.runCount })}
              >
                {t('runGroupCount', { n: group.runCount })}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </td>
  );

  const lead = (label: string, ids: string[], checked: boolean, indeterminate: boolean, selectLabel: string) => (
    <>
      <td className={`${td} text-ink-400 tabular-nums`}>{label}</td>
      <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
        <SelectBox
          checked={checked}
          indeterminate={indeterminate}
          disabled={!ctx.canDelete || ids.length === 0}
          label={selectLabel}
          title={selectTitle}
          onChange={(on) => ctx.onSelect(ids, on)}
        />
      </td>
    </>
  );

  if (!multi) {
    return (
      <ClickableRow testId="run-row" label={pr} className={rowClass(color, allSelected)} onActivate={() => ctx.onOpenRun(latest.id)}>
        {lead(String(number), deletableIds, allSelected, false, t('selectPrRuns', { pr }))}
        {prCell}
        <RunDetailCells run={latest} ctx={ctx} />
      </ClickableRow>
    );
  }

  return (
    <>
      <ClickableRow testId="run-group-row" label={pr} className={rowClass(color, allSelected)} onActivate={onToggle}>
        {lead(String(number), deletableIds, allSelected, selectedCount > 0, t('selectPrRuns', { pr }))}
        {prCell}
        <td className={td}><RunStatusBadge status={latest.status} /></td>
        <td className={td}>
          <div className="flex flex-col items-start gap-1">
            <RunProviderBadge provider={latest.provider} />
            <RunModelBadge model={latest.model} effort={latest.effort} fallbackFrom={latest.fallbackFrom} />
          </div>
        </td>
        <td className={td}>
          <RunSeverityChips status={latest.status} findingsCount={latest.findingsCount} severityCounts={latest.severityCounts} detail={latest.detail} />
        </td>
        <td className={`${td} font-mono tabular-nums font-semibold whitespace-nowrap`}><RunTokens value={group.inputTokens} /></td>
        <td className={`${td} font-mono tabular-nums font-semibold whitespace-nowrap`}><RunTokens value={group.outputTokens} /></td>
        {/* Like status, provider and model: the latest run's duration, not a sum. */}
        <td className={`${td} font-mono tabular-nums whitespace-nowrap`} data-testid="run-duration"><RunDuration run={latest} /></td>
        <td className={`${td} font-mono font-semibold text-ink-900 dark:text-ink-100 whitespace-nowrap`}>{formatCost(group.costUsd)}</td>
        <td className={`${td} text-ink-500 dark:text-ink-400 whitespace-nowrap`}><RunDate value={latest.createdAt} /></td>
        <td className={`${td} text-center text-ink-300 dark:text-ink-600`}>—</td>
      </ClickableRow>
      {expanded
        ? group.runs.map((run, i) => (
            <ClickableRow
              key={run.id}
              testId="run-sub-row"
              label={`${pr} · ${run.headSha.slice(0, 7)}`}
              className={`${rowClass(color, ctx.selected.has(run.id))} text-[11px]`}
              onActivate={() => ctx.onOpenRun(run.id)}
            >
              {lead(`${number}.${i + 1}`, isDeletable(run) ? [run.id] : [], ctx.selected.has(run.id), false, t('selectRun'))}
              <td className={`${td} ps-10 whitespace-nowrap`}>
                <span className="inline-flex items-center gap-1.5 font-mono text-ink-500 dark:text-ink-400" dir="ltr">
                  <CornerDownLeft className="w-3 h-3 rtl:-scale-x-100" aria-hidden="true" />
                  {run.headSha.slice(0, 7)}
                </span>
              </td>
              <RunDetailCells run={run} ctx={ctx} />
            </ClickableRow>
          ))
        : null}
    </>
  );
}

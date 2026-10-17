import { randomUUID } from 'node:crypto';
import { compareRuns, filterRuns } from './memory-runs.js';
import {
  DEFAULT_RUN_RETENTION_DAYS,
  FINISHED_RUN_STATUSES,
  RunCountMismatchError,
  RunsNotFoundError,
  runTokens,
  usageMonth,
  type DeleteRunsTarget,
  type ListReviewRunGroupsResult,
  type MaintenanceKind,
  type MaintenanceRun,
  type MonthlyUsage,
  type RetentionPolicy,
  type ReviewRunGroup,
} from './run-types.js';
import type { ListReviewRunsOptions, ReviewRun, WorkspaceSettings } from './types.js';

// In-memory twins of pg-usage.ts, pg-run-groups.ts and pg-maintenance.ts, used by MemoryStore.

/** Adds a finished run to its month's usage (the run's createdAt picks the month). */
/** Adds (sign 1) or takes back (sign -1) one finished run in its month's usage. */
export function addMemoryUsage(usage: Map<string, MonthlyUsage>, run: ReviewRun, sign: 1 | -1 = 1): void {
  if (!FINISHED_RUN_STATUSES.includes(run.status)) return;
  const month = usageMonth(run.createdAt);
  const key = `${run.workspaceId}\u0000${month}`;
  const row = usage.get(key) ?? {
    workspaceId: run.workspaceId,
    month,
    runsTotal: 0,
    runsCompleted: 0,
    runsFailed: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const tokens = runTokens(run);
  usage.set(key, {
    ...row,
    runsTotal: row.runsTotal + sign * 1,
    runsCompleted: row.runsCompleted + sign * (run.status === 'completed' ? 1 : 0),
    runsFailed: row.runsFailed + sign * (run.status === 'failed' ? 1 : 0),
    costUsd: row.costUsd + sign * (run.costUsd ?? 0),
    inputTokens: row.inputTokens + sign * (tokens.inputTokens ?? 0),
    outputTokens: row.outputTokens + sign * (tokens.outputTokens ?? 0),
  });
}

const sumOrNull = (values: Array<number | null>): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;

export function groupMemoryRuns(
  runs: Iterable<ReviewRun>,
  workspaceId: string,
  opts: ListReviewRunsOptions,
): ListReviewRunGroupsResult {
  const matching = filterRuns(runs, workspaceId, opts);
  const newestFirst = compareRuns('createdAt', 'desc');
  const byPr = new Map<string, ReviewRun[]>();
  for (const r of matching) {
    const key = `${r.repoFullName}#${r.pullNumber}`;
    byPr.set(key, [...(byPr.get(key) ?? []), { ...r }]);
  }
  const groups: ReviewRunGroup[] = [...byPr.values()].map((list) => {
    const sorted = list.sort(newestFirst);
    const latest = sorted[0]!;
    return {
      repoFullName: latest.repoFullName,
      pullNumber: latest.pullNumber,
      runs: sorted,
      runCount: sorted.length,
      costUsd: sumOrNull(sorted.map((r) => r.costUsd)),
      inputTokens: sumOrNull(sorted.map((r) => runTokens(r).inputTokens)),
      outputTokens: sumOrNull(sorted.map((r) => runTokens(r).outputTokens)),
    };
  });
  const byLatest = compareRuns(opts.sort, opts.dir);
  groups.sort((a, b) => byLatest(a.runs[0]!, b.runs[0]!));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  return { groups: groups.slice(offset, offset + limit), total: groups.length, totalRuns: matching.length };
}

/** Same checks as deletePgReviewRuns; nothing is deleted when a check fails. */
export function deleteMemoryRuns(runs: Map<string, ReviewRun>, workspaceId: string, target: DeleteRunsTarget): number {
  let candidates: ReviewRun[];
  if ('ids' in target) {
    const ids = [...new Set(target.ids)];
    candidates = ids.map((id) => runs.get(id)).filter((r): r is ReviewRun => r?.workspaceId === workspaceId);
    if (candidates.length !== ids.length) throw new RunsNotFoundError();
  } else {
    candidates = filterRuns(runs.values(), workspaceId, target.filters);
    if (candidates.length !== target.expectedCount) throw new RunCountMismatchError(candidates.length);
  }
  let deleted = 0;
  for (const r of candidates) {
    if (FINISHED_RUN_STATUSES.includes(r.status) && runs.delete(r.id)) deleted++;
  }
  return deleted;
}

export function memoryRetentionPolicies(
  runs: Iterable<ReviewRun>,
  settings: Map<string, WorkspaceSettings>,
): RetentionPolicy[] {
  const workspaces = new Set<string>();
  for (const r of runs) workspaces.add(r.workspaceId);
  const policies: RetentionPolicy[] = [];
  for (const workspaceId of [...workspaces].sort()) {
    const s = settings.get(workspaceId);
    const days = s ? (s.runRetentionDays === undefined ? DEFAULT_RUN_RETENTION_DAYS : s.runRetentionDays) : DEFAULT_RUN_RETENTION_DAYS;
    if (days !== null && days > 0) policies.push({ workspaceId, retentionDays: days });
  }
  return policies;
}

export function pruneMemoryRuns(
  runs: Map<string, ReviewRun>,
  workspaceId: string,
  createdBefore: Date,
  limit: number,
): number {
  const batch = [...runs.values()]
    .filter((r) => r.workspaceId === workspaceId && FINISHED_RUN_STATUSES.includes(r.status) && r.createdAt < createdBefore)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, limit);
  for (const r of batch) runs.delete(r.id);
  return batch.length;
}

/** The lease: an unfinished run of this kind blocks a new one unless it started before staleBefore. */
export function startMemoryMaintenance(
  log: MaintenanceRun[],
  kind: MaintenanceKind,
  staleBefore: Date,
): MaintenanceRun | null {
  const now = new Date();
  for (const [i, run] of log.entries()) {
    if (run.kind === kind && run.finishedAt === null && run.startedAt < staleBefore) {
      log[i] = { ...run, finishedAt: now, error: 'abandoned' };
    }
  }
  if (log.some((r) => r.kind === kind && r.finishedAt === null)) return null;
  const run: MaintenanceRun = { id: randomUUID(), kind, startedAt: now, finishedAt: null, deletedCount: 0, error: null };
  log.push(run);
  return { ...run };
}

export function finishMemoryMaintenance(
  log: MaintenanceRun[],
  id: string,
  result: { deletedCount: number; error: string | null },
): void {
  const i = log.findIndex((r) => r.id === id);
  if (i >= 0) log[i] = { ...log[i]!, finishedAt: new Date(), ...result };
}

export function latestMemoryMaintenance(log: MaintenanceRun[], kind: MaintenanceKind): MaintenanceRun | null {
  // Two runs can start in the same millisecond: the one recorded last wins the tie.
  let latest: MaintenanceRun | undefined;
  for (const run of log) {
    if (run.kind === kind && (!latest || run.startedAt.getTime() >= latest.startedAt.getTime())) latest = run;
  }
  return latest ? { ...latest } : null;
}

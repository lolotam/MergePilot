import { randomUUID } from 'node:crypto';
import { addMemoryUsage } from './memory-maintenance.js';
import { compareRuns, filterRuns, findActiveRun, selectLatestFailedRuns } from './memory-runs.js';
import {
  ACTIVE_RUN_STATUSES,
  ActiveRunExistsError,
  REUSABLE_RUN_STATUSES,
  type FinishReviewRunOptions,
  type LatestFailedRunsOptions,
  type ListReviewRunsOptions,
  type ListReviewRunsResult,
  type NewReviewRun,
  type ReviewRun,
  type StaleRunRef,
} from './types.js';

export interface MemoryRunTables {
  runs: Map<string, ReviewRun>;
  deletedWorkspaces: Set<string>;
  usage: Map<string, import('./types.js').MonthlyUsage>;
  assertLive(workspaceId: string): void;
}

export function memoryCreateReviewRun(store: MemoryRunTables, run: NewReviewRun): ReviewRun {
  store.assertLive(run.workspaceId);
  const now = new Date();
  const starting = {
    finishedAt: null,
    updatedAt: now,
    costUsd: run.costUsd ?? null,
    detail: run.detail ?? null,
    provider: run.provider ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    fallbackFrom: run.fallbackFrom ?? null,
    findingsCount: run.findingsCount ?? null,
    result: run.result ?? null,
    reviewUrl: run.reviewUrl ?? null,
    botSlot: run.botSlot ?? 1,
    botName: run.botName ?? null,
    ...(run.skillName ? { skillName: run.skillName } : {}),
  };
  let reusable: ReviewRun | undefined;
  if (run.jobId) {
    // Only a queued/running/failed run of this job is reused; completed and skipped runs stay.
    for (const existing of store.runs.values()) {
      if (
        existing.workspaceId === run.workspaceId &&
        existing.jobId === run.jobId &&
        existing.botSlot === starting.botSlot &&
        REUSABLE_RUN_STATUSES.includes(existing.status)
      ) {
        reusable = existing;
        break;
      }
    }
  }
  // Emulates the partial unique index of migration 0004: one queued/running run per head.
  if (
    ACTIVE_RUN_STATUSES.includes(run.status) &&
    findActiveRun(store.runs.values(), { ...run, botSlot: starting.botSlot }, reusable?.id)
  ) {
    throw new ActiveRunExistsError(run.repoFullName, run.pullNumber, starting.botSlot);
  }
  if (reusable) {
    // A retry on Default must not keep the skill the earlier attempt ran with (ADR-0034).
    const { skillName: _earlierSkill, ...earlier } = reusable;
    const updated: ReviewRun = { ...earlier, ...run, ...starting };
    store.runs.set(reusable.id, updated);
    return { ...updated };
  }
  const created: ReviewRun = { ...run, ...starting, id: randomUUID(), createdAt: now };
  store.runs.set(created.id, created);
  return { ...created };
}

export function memoryFinishReviewRun(
  store: MemoryRunTables,
  workspaceId: string,
  id: string,
  result: FinishReviewRunOptions,
): void {
  const run = store.runs.get(id);
  if (!run || run.workspaceId !== workspaceId) return;
  const now = new Date();
  const finished: ReviewRun = { ...run, ...result, finishedAt: now, updatedAt: now };
  store.runs.set(id, finished);
  // A run finished twice (e.g. failed by the stale sweep, then finished by its worker) replaces
  // its earlier usage instead of counting twice.
  if (run.finishedAt) addMemoryUsage(store.usage, run, -1);
  addMemoryUsage(store.usage, finished);
}

export function memoryFailStaleRuns(
  store: MemoryRunTables,
  heartbeatBefore: Date,
  onFailed?: (failed: readonly StaleRunRef[]) => void,
): number {
  const refs: StaleRunRef[] = [];
  const now = new Date();
  for (const [id, r] of store.runs.entries()) {
    if (
      (r.status === 'running' || r.status === 'queued') &&
      r.updatedAt < heartbeatBefore &&
      !store.deletedWorkspaces.has(r.workspaceId)
    ) {
      const failed: ReviewRun = { ...r, status: 'failed', detail: 'interrupted', finishedAt: now, updatedAt: now };
      store.runs.set(id, failed);
      addMemoryUsage(store.usage, { ...failed, costUsd: null, result: null });
      refs.push({ workspaceId: r.workspaceId, id });
    }
  }
  if (refs.length > 0) onFailed?.(refs);
  return refs.length;
}

export function memoryListReviewRuns(
  store: MemoryRunTables,
  workspaceId: string,
  limitOrOptions?: number | ListReviewRunsOptions,
): ReviewRun[] | ListReviewRunsResult {
  if (typeof limitOrOptions === 'number' || limitOrOptions === undefined) {
    const limit = limitOrOptions ?? 50;
    return [...store.runs.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  const opts = limitOrOptions;
  const filtered = filterRuns(store.runs.values(), workspaceId, opts).sort(compareRuns(opts.sort, opts.dir));
  const total = filtered.length;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  return { runs: filtered.slice(offset, offset + limit), total };
}

export function memoryTouchReviewRun(store: MemoryRunTables, workspaceId: string, id: string): void {
  const run = store.runs.get(id);
  if (!run || run.workspaceId !== workspaceId) return;
  if (run.status !== 'queued' && run.status !== 'running') return;
  store.runs.set(id, { ...run, updatedAt: new Date() });
}

export function memoryListLatestFailedRuns(
  store: MemoryRunTables,
  workspaceId: string,
  options?: LatestFailedRunsOptions,
): ReviewRun[] {
  return selectLatestFailedRuns(store.runs.values(), workspaceId, options);
}

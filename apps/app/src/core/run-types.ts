import type { ListReviewRunsOptions, ReviewRun, ReviewRunStatus } from './types.js';

/** Run retention choices offered in Settings (ADR-0014); `null` keeps runs forever. */
export const RUN_RETENTION_CHOICES = [30, 90, 180, 365] as const;
export const DEFAULT_RUN_RETENTION_DAYS = 30;

/**
 * Palette keys a workspace may pick per repository for the runs table (ADR-0014). The web app maps
 * each key to fixed Tailwind classes; free-form colors are never stored.
 */
export const REPO_COLOR_KEYS = [
  'sky',
  'teal',
  'emerald',
  'lime',
  'amber',
  'orange',
  'rose',
  'fuchsia',
  'violet',
  'indigo',
] as const;
export type RepoColorKey = (typeof REPO_COLOR_KEYS)[number];
export const MAX_REPO_COLORS = 500;

/** Runs in these states are done: they count in the monthly usage and may be deleted. */
export const FINISHED_RUN_STATUSES: readonly ReviewRunStatus[] = ['completed', 'failed', 'skipped'];

/** The runs list filters (repo, status, date window, provider, search) without paging or sort. */
export type RunFilters = Pick<ListReviewRunsOptions, 'repo' | 'status' | 'from' | 'to' | 'provider' | 'q'>;

/**
 * What a bulk delete targets. `ids` must all be runs of the workspace; `filters` must match exactly
 * `expectedCount` runs (the count the user saw). Only finished runs are deleted either way.
 */
export type DeleteRunsTarget =
  | { ids: string[] }
  | { filters: RunFilters; expectedCount: number };

/** Thrown by AppStore.deleteReviewRuns when an id is not a run of the workspace. */
export class RunsNotFoundError extends Error {
  constructor() {
    super('one or more review runs were not found in this workspace');
    this.name = 'RunsNotFoundError';
  }
}

/** Thrown by AppStore.deleteReviewRuns when the filters match a different number of runs. */
export class RunCountMismatchError extends Error {
  constructor(readonly actual: number) {
    super(`the filters now match ${actual} review runs`);
    this.name = 'RunCountMismatchError';
  }
}

/** The runs of one pull request that match the list filters (grouped runs list). */
export interface ReviewRunGroup {
  repoFullName: string;
  pullNumber: number;
  /** Matching runs, newest first; `runs[0]` is the latest. */
  runs: ReviewRun[];
  runCount: number;
  /** Sums over the matching runs; null when no run has a value. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ListReviewRunGroupsResult {
  groups: ReviewRunGroup[];
  /** Number of PR groups that match (pagination is over groups). */
  total: number;
  /** Number of runs that match the filters. */
  totalRuns: number;
}

/** Per workspace and UTC month; finished runs are added, deleting runs never subtracts. */
export interface MonthlyUsage {
  workspaceId: string;
  /** `YYYY-MM-01` (UTC). */
  month: string;
  runsTotal: number;
  runsCompleted: number;
  runsFailed: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type MaintenanceKind = 'retention';

export interface MaintenanceRun {
  id: string;
  kind: MaintenanceKind;
  startedAt: Date;
  finishedAt: Date | null;
  deletedCount: number;
  error: string | null;
}

export interface RetentionPolicy {
  workspaceId: string;
  retentionDays: number;
}

/** Bulk delete, grouped list, retention and monthly usage part of AppStore (ADR-0014). */
export interface RunMaintenanceStore {
  /**
   * Groups the matching runs by (repo, PR). Paging (limit/offset) is over groups and the sort key
   * applies to each group's latest matching run.
   */
  listReviewRunGroups(workspaceId: string, options: ListReviewRunsOptions): Promise<ListReviewRunGroupsResult>;
  /**
   * Deletes finished runs (queued/running are never deleted) under the live-workspace lock and
   * returns how many were deleted. Throws RunsNotFoundError or RunCountMismatchError; then nothing
   * is deleted.
   */
  deleteReviewRuns(workspaceId: string, target: DeleteRunsTarget): Promise<number>;
  /** Workspaces with runs and a finite retention (no settings row = the 30-day default). */
  listRetentionPolicies(): Promise<RetentionPolicy[]>;
  /** Deletes up to `limit` finished runs created before `createdBefore`, oldest first. */
  pruneReviewRuns(workspaceId: string, createdBefore: Date, limit: number): Promise<number>;
  listMonthlyUsage(workspaceId: string): Promise<MonthlyUsage[]>;
  /**
   * Takes the job lease: records a started run unless another run of this kind is unfinished.
   * An unfinished run that started before `staleBefore` is closed as abandoned first.
   * Returns null when the lease is held.
   */
  startMaintenanceRun(kind: MaintenanceKind, staleBefore: Date): Promise<MaintenanceRun | null>;
  finishMaintenanceRun(id: string, result: { deletedCount: number; error: string | null }): Promise<void>;
  getLatestMaintenanceRun(kind: MaintenanceKind): Promise<MaintenanceRun | null>;
}

/** `YYYY-MM-01` of the UTC month containing `date`. */
export function usageMonth(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-01`;
}

/** Input and output tokens recorded on a run's result payload; null when unknown. */
export function runTokens(run: Pick<ReviewRun, 'result'>): { inputTokens: number | null; outputTokens: number | null } {
  const usage = run.result?.usage;
  return {
    inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null,
    outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null,
  };
}

/**
 * How long a run took: finishedAt minus createdAt (runs have no separate start time, so a queued
 * wait counts). Null while the run is queued or running, or when the timestamps are missing or
 * out of order. `runDurationExpr` (pg-run-filters.ts) is the SQL twin used for sorting.
 */
export function runDurationMs(run: Pick<ReviewRun, 'status' | 'createdAt' | 'finishedAt'>): number | null {
  if (!FINISHED_RUN_STATUSES.includes(run.status) || !run.finishedAt) return null;
  const ms = run.finishedAt.getTime() - run.createdAt.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

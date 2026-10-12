import { ACTIVE_RUN_STATUSES, type LatestFailedRunsOptions, type ReviewRun } from './types.js';

/** The key of the one-active-run-per-head rule (migration 0004). */
export interface ActiveRunKey {
  workspaceId: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
}

/** The queued/running run for this key, ignoring `excludeId` (the run being reused). */
export function findActiveRun(
  runs: Iterable<ReviewRun>,
  key: ActiveRunKey,
  excludeId?: string,
): ReviewRun | null {
  for (const r of runs) {
    if (
      r.id !== excludeId &&
      r.workspaceId === key.workspaceId &&
      r.repoFullName === key.repoFullName &&
      r.pullNumber === key.pullNumber &&
      r.headSha === key.headSha &&
      ACTIVE_RUN_STATUSES.includes(r.status)
    ) {
      return r;
    }
  }
  return null;
}

const newestFirst = (a: ReviewRun, b: ReviewRun): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

/** In-memory twin of `listPgLatestFailedRuns`. */
export function selectLatestFailedRuns(
  runs: Iterable<ReviewRun>,
  workspaceId: string,
  options?: LatestFailedRunsOptions,
): ReviewRun[] {
  const limit = options?.limit ?? 25;
  const allowed = options?.repo && options.repo.length > 0 ? new Set(options.repo) : null;

  const latestByPr = new Map<string, ReviewRun>();
  for (const r of runs) {
    if (r.workspaceId !== workspaceId) continue;
    if (allowed && !allowed.has(r.repoFullName)) continue;
    const key = `${r.repoFullName}#${r.pullNumber}`;
    const current = latestByPr.get(key);
    if (!current || newestFirst(r, current) < 0) latestByPr.set(key, r);
  }

  // The latest run over ALL runs decides; the date window then applies to that latest run, so a
  // PR that failed inside the window but later completed is not retried.
  const candidates: ReviewRun[] = [];
  for (const latest of latestByPr.values()) {
    if (latest.status !== 'failed') continue;
    if (options?.from && latest.createdAt < options.from) continue;
    if (options?.to && latest.createdAt > options.to) continue;
    candidates.push({ ...latest });
  }
  return candidates.sort(newestFirst).slice(0, limit);
}

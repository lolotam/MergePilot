import {
  ACTIVE_RUN_STATUSES,
  type LatestFailedRunsOptions,
  type ListReviewRunsOptions,
  type ReviewRun,
} from './types.js';
import { runDurationMs, runTokens, type RunFilters } from './run-types.js';

/** The key of the one-active-run-per-head-and-bot rule (migrations 0004, 0009). */
export interface ActiveRunKey {
  workspaceId: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  /** Undefined matches a run of any bot; runs without a slot are the main bot's (1). */
  botSlot?: number | undefined;
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
      (key.botSlot === undefined || (r.botSlot ?? 1) === key.botSlot) &&
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

/** In-memory twin of `runFilterConditions` (pg-run-filters.ts): the runs list filters. */
export function filterRuns(runs: Iterable<ReviewRun>, workspaceId: string, opts: RunFilters): ReviewRun[] {
  const repos = opts.repo && opts.repo.length > 0 ? new Set(opts.repo) : null;
  const statuses = opts.status && opts.status.length > 0 ? new Set(opts.status) : null;
  const q = opts.q?.trim().toLowerCase() ?? '';
  const out: ReviewRun[] = [];
  for (const r of runs) {
    if (r.workspaceId !== workspaceId) continue;
    if (repos && !repos.has(r.repoFullName)) continue;
    if (statuses && !statuses.has(r.status)) continue;
    if (opts.from && r.createdAt < opts.from) continue;
    if (opts.to && r.createdAt > opts.to) continue;
    if (opts.provider && r.provider !== opts.provider) continue;
    if (
      q &&
      ![r.repoFullName, String(r.pullNumber), r.model ?? '', r.detail ?? ''].some((v) => v.toLowerCase().includes(q))
    ) {
      continue;
    }
    out.push(r);
  }
  return out;
}

/** In-memory twin of `runSortOrder`: a comparator for a sort key, ties broken by id. */
export function compareRuns(
  sortKey: ListReviewRunsOptions['sort'],
  dir: ListReviewRunsOptions['dir'],
): (a: ReviewRun, b: ReviewRun) => number {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let cmp: number;
    switch (sortKey ?? 'createdAt') {
      case 'repo':
        cmp = a.repoFullName.localeCompare(b.repoFullName);
        break;
      case 'pullNumber':
        cmp = a.pullNumber - b.pullNumber;
        break;
      case 'status':
        cmp = a.status.localeCompare(b.status);
        break;
      case 'provider':
        cmp = (a.provider ?? '').localeCompare(b.provider ?? '');
        break;
      case 'model':
        cmp = (a.model ?? '').localeCompare(b.model ?? '');
        break;
      case 'findingsCount':
        cmp = (a.findingsCount ?? 0) - (b.findingsCount ?? 0);
        break;
      case 'costUsd':
        cmp = (a.costUsd ?? 0) - (b.costUsd ?? 0);
        break;
      case 'inputTokens':
        cmp = (runTokens(a).inputTokens ?? 0) - (runTokens(b).inputTokens ?? 0);
        break;
      case 'outputTokens':
        cmp = (runTokens(a).outputTokens ?? 0) - (runTokens(b).outputTokens ?? 0);
        break;
      case 'duration': {
        // Like the SQL `nulls last`: runs with no duration go last in both directions.
        const da = runDurationMs(a);
        const db = runDurationMs(b);
        if (da === null || db === null) {
          if (da !== db) return da === null ? 1 : -1;
          cmp = 0;
        } else {
          cmp = da - db;
        }
        break;
      }
      case 'createdAt':
      default:
        cmp = a.createdAt.getTime() - b.createdAt.getTime();
        break;
    }
    if (cmp !== 0) return sign * cmp;
    return a.id.localeCompare(b.id);
  };
}

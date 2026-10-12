import { eq, gte, ilike, inArray, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { ListReviewRunsOptions } from '../core/types.js';
import type { RunFilters } from '../core/run-types.js';
import { reviewRuns } from './schema.js';

/**
 * WHERE conditions of the runs list filters. The list, the grouped list and the bulk delete by
 * filters all use these, so "the runs the user sees" and "the runs that get deleted" match.
 */
export function runFilterConditions(workspaceId: string, opts: RunFilters): SQL[] {
  const conditions: SQL[] = [eq(reviewRuns.workspaceId, workspaceId)];
  if (opts.repo && opts.repo.length > 0) {
    conditions.push(inArray(reviewRuns.repoFullName, opts.repo));
  }
  if (opts.status && opts.status.length > 0) {
    conditions.push(inArray(reviewRuns.status, opts.status));
  }
  if (opts.from) {
    conditions.push(gte(reviewRuns.createdAt, opts.from));
  }
  if (opts.to) {
    conditions.push(lte(reviewRuns.createdAt, opts.to));
  }
  if (opts.provider) {
    conditions.push(eq(reviewRuns.provider, opts.provider));
  }
  if (opts.q && opts.q.trim().length > 0) {
    const escaped = opts.q.trim().replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    conditions.push(
      or(
        ilike(reviewRuns.repoFullName, pattern),
        sql`CAST(${reviewRuns.pullNumber} AS text) ILIKE ${pattern}`,
        ilike(reviewRuns.model, pattern),
        ilike(reviewRuns.detail, pattern),
      )!,
    );
  }
  return conditions;
}

/** A token count from the run's result payload (`result.usage`); NULL when absent. */
export function tokensExpr(result: SQLWrapper, field: 'inputTokens' | 'outputTokens'): SQL {
  // `field` is one of two fixed names, inlined as a literal (a bound `jsonb -> $1` is ambiguous).
  const key = sql.raw(`'${field}'`);
  return sql`(CASE WHEN jsonb_typeof(${result} -> 'usage' -> ${key}) = 'number'
    THEN (${result} -> 'usage' ->> ${key})::numeric END)`;
}

/** The columns a sort key reads: the review_runs table itself or a subquery over it. */
export interface SortableRunColumns {
  repoFullName: SQLWrapper;
  pullNumber: SQLWrapper;
  status: SQLWrapper;
  provider: SQLWrapper;
  model: SQLWrapper;
  findingsCount: SQLWrapper;
  costUsd: SQLWrapper;
  result: SQLWrapper;
  createdAt: SQLWrapper;
  finishedAt: SQLWrapper;
}

/** ORDER BY expression of a sort key; nullable values (older runs) go last in both directions. */
export function runSortOrder(
  cols: SortableRunColumns,
  sortKey: ListReviewRunsOptions['sort'],
  dir: ListReviewRunsOptions['dir'],
): SQL {
  let column: SQL | SQLWrapper;
  switch (sortKey) {
    case 'repo':
      column = cols.repoFullName;
      break;
    case 'pullNumber':
      column = cols.pullNumber;
      break;
    case 'status':
      column = cols.status;
      break;
    case 'provider':
      column = cols.provider;
      break;
    case 'model':
      column = cols.model;
      break;
    case 'findingsCount':
      column = cols.findingsCount;
      break;
    case 'costUsd':
      column = cols.costUsd;
      break;
    case 'inputTokens':
      column = tokensExpr(cols.result, 'inputTokens');
      break;
    case 'outputTokens':
      column = tokensExpr(cols.result, 'outputTokens');
      break;
    case 'duration':
      column = sql`coalesce(extract(epoch from (${cols.finishedAt} - ${cols.createdAt})), 0)`;
      break;
    case 'createdAt':
    default:
      column = cols.createdAt;
      break;
  }
  return dir === 'asc' ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
}

import { and, asc, desc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import type { ListReviewRunsOptions, ReviewRun } from '../core/types.js';
import type { ListReviewRunGroupsResult, ReviewRunGroup } from '../core/run-types.js';
import { mapReviewRunRow } from './pg-runs.js';
import { runFilterConditions, runSortOrder, tokensExpr } from './pg-run-filters.js';
import type { AppDb } from './pg-store.js';
import { reviewRuns } from './schema.js';

const nullableNumber = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/**
 * The runs list grouped by (repo, PR). Each matching run is ranked inside its PR, the latest one
 * (rank 1) stands for the group: the sort key and paging apply to it, so a PR's runs never split
 * across pages. Sums are over the group's matching runs.
 */
export async function listPgRunGroups(
  db: AppDb,
  workspaceId: string,
  opts: ListReviewRunsOptions,
): Promise<ListReviewRunGroupsResult> {
  const where = and(...runFilterConditions(workspaceId, opts));
  const pr = sql`partition by ${reviewRuns.repoFullName}, ${reviewRuns.pullNumber}`;
  const ranked = db
    .select({
      ...getTableColumns(reviewRuns),
      rn: sql<number>`row_number() over (${pr} order by ${reviewRuns.createdAt} desc, ${reviewRuns.id} desc)`.as('rn'),
      groupRuns: sql<string>`count(*) over (${pr})`.as('group_runs'),
      groupCost: sql<string | null>`sum(${reviewRuns.costUsd}) over (${pr})`.as('group_cost'),
      groupIn: sql<string | null>`sum(${tokensExpr(reviewRuns.result, 'inputTokens')}) over (${pr})`.as('group_in'),
      groupOut: sql<string | null>`sum(${tokensExpr(reviewRuns.result, 'outputTokens')}) over (${pr})`.as('group_out'),
    })
    .from(reviewRuns)
    .where(where)
    .as('ranked');

  const [groupCount, runCount] = await Promise.all([
    db.select({ n: sql<string>`count(*)` }).from(ranked).where(eq(ranked.rn, 1)),
    db.select({ n: sql<string>`count(*)` }).from(reviewRuns).where(where),
  ]);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const tieBreaker = opts.dir === 'asc' ? asc(ranked.id) : desc(ranked.id);
  const heads = await db
    .select()
    .from(ranked)
    .where(eq(ranked.rn, 1))
    .orderBy(runSortOrder(ranked, opts.sort, opts.dir), tieBreaker)
    .limit(limit)
    .offset(offset);

  const runsByPr = new Map<string, ReviewRun[]>();
  if (heads.length > 0) {
    const prs = heads.map((h) =>
      and(eq(reviewRuns.repoFullName, h.repoFullName), eq(reviewRuns.pullNumber, h.pullNumber)),
    );
    const rows = await db
      .select()
      .from(reviewRuns)
      .where(and(where, or(...prs)))
      .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id));
    for (const row of rows) {
      const key = `${row.repoFullName}#${row.pullNumber}`;
      const list = runsByPr.get(key) ?? [];
      list.push(mapReviewRunRow(row));
      runsByPr.set(key, list);
    }
  }

  const groups: ReviewRunGroup[] = heads.map((h) => ({
    repoFullName: h.repoFullName,
    pullNumber: Number(h.pullNumber),
    runs: runsByPr.get(`${h.repoFullName}#${h.pullNumber}`) ?? [],
    runCount: Number(h.groupRuns),
    costUsd: nullableNumber(h.groupCost),
    inputTokens: nullableNumber(h.groupIn),
    outputTokens: nullableNumber(h.groupOut),
  }));

  return {
    groups,
    total: Number(groupCount[0]?.n ?? 0),
    totalRuns: Number(runCount[0]?.n ?? 0),
  };
}

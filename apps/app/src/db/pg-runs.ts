import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type {
  FinishReviewRunOptions,
  ListReviewRunsOptions,
  ListReviewRunsResult,
  ReviewRun,
  ReviewRunResultPayload,
  ReviewRunStatus,
} from '../core/types.js';
import { reviewRuns } from './schema.js';
import type { AppDb } from './pg-store.js';
import { withLiveWorkspace } from './workspace-lock.js';

export function mapReviewRunRow(row: typeof reviewRuns.$inferSelect): ReviewRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId ?? null,
    installationId: Number(row.installationId),
    repoFullName: row.repoFullName,
    pullNumber: Number(row.pullNumber),
    headSha: row.headSha,
    status: row.status as ReviewRunStatus,
    costUsd: row.costUsd !== null ? Number(row.costUsd) : null,
    detail: row.detail,
    createdAt: new Date(row.createdAt),
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    fallbackFrom: row.fallbackFrom ?? null,
    findingsCount: row.findingsCount !== null ? Number(row.findingsCount) : null,
    result: (row.result as ReviewRunResultPayload | null) ?? null,
    reviewUrl: row.reviewUrl ?? null,
  };
}

export async function queryPgReviewRuns(
  db: AppDb,
  workspaceId: string,
  limitOrOptions?: number | ListReviewRunsOptions,
): Promise<ReviewRun[] | ListReviewRunsResult> {
  if (typeof limitOrOptions === 'number' || limitOrOptions === undefined) {
    const limit = limitOrOptions ?? 50;
    const rows = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.workspaceId, workspaceId))
      .orderBy(desc(reviewRuns.createdAt), desc(reviewRuns.id))
      .limit(limit);
    return rows.map(mapReviewRunRow);
  }

  const opts = limitOrOptions;
  const conditions = [eq(reviewRuns.workspaceId, workspaceId)];

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

  const whereClause = and(...conditions);

  const countRows = await db
    .select({ count: sql<string>`count(*)` })
    .from(reviewRuns)
    .where(whereClause);
  const total = Number(countRows[0]?.count ?? 0);

  const sortKey = opts.sort ?? 'createdAt';
  const isAsc = opts.dir === 'asc';

  let sortColumn;
  switch (sortKey) {
    case 'repo':
      sortColumn = reviewRuns.repoFullName;
      break;
    case 'pullNumber':
      sortColumn = reviewRuns.pullNumber;
      break;
    case 'status':
      sortColumn = reviewRuns.status;
      break;
    case 'provider':
      sortColumn = reviewRuns.provider;
      break;
    case 'model':
      sortColumn = reviewRuns.model;
      break;
    case 'findingsCount':
      sortColumn = reviewRuns.findingsCount;
      break;
    case 'costUsd':
      sortColumn = reviewRuns.costUsd;
      break;
    case 'duration':
      sortColumn = sql`coalesce(extract(epoch from (${reviewRuns.finishedAt} - ${reviewRuns.createdAt})), 0)`;
      break;
    case 'createdAt':
    default:
      sortColumn = reviewRuns.createdAt;
      break;
  }

  const primaryOrder = isAsc ? asc(sortColumn) : desc(sortColumn);
  const tieBreaker = isAsc ? asc(reviewRuns.id) : desc(reviewRuns.id);

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await db
    .select()
    .from(reviewRuns)
    .where(whereClause)
    .orderBy(primaryOrder, tieBreaker)
    .limit(limit)
    .offset(offset);

  return {
    runs: rows.map(mapReviewRunRow),
    total,
  };
}

export async function failPgStaleRuns(db: AppDb, olderThan: Date): Promise<number> {
  const res = await db
    .update(reviewRuns)
    .set({ status: 'failed', detail: 'interrupted', finishedAt: new Date() })
    .where(
      and(
        or(eq(reviewRuns.status, 'running'), eq(reviewRuns.status, 'queued')),
        lt(reviewRuns.createdAt, olderThan),
      ),
    )
    .returning();
  return res.length;
}

export async function createPgReviewRun(
  db: AppDb,
  run: Omit<ReviewRun, 'id' | 'createdAt' | 'finishedAt'>,
): Promise<ReviewRun> {
  return withLiveWorkspace(db, run.workspaceId, async (tx) => {
    if (run.jobId) {
      const existing = await tx
        .select()
        .from(reviewRuns)
        .where(
          and(
            eq(reviewRuns.workspaceId, run.workspaceId),
            eq(reviewRuns.jobId, run.jobId),
          ),
        );
      if (existing.length > 0 && existing[0]) {
        const row = existing[0];
        await tx
          .update(reviewRuns)
          .set({
            status: run.status,
            headSha: run.headSha,
            costUsd: run.costUsd !== null ? String(run.costUsd) : null,
            detail: run.detail,
            finishedAt: null,
          })
          .where(eq(reviewRuns.id, row.id));
        return mapReviewRunRow({
          ...row,
          status: run.status,
          headSha: run.headSha,
          costUsd: run.costUsd !== null ? String(run.costUsd) : null,
          detail: run.detail,
          finishedAt: null,
        });
      }
    }
    const id = randomUUID();
    const createdAt = new Date();
    await tx.insert(reviewRuns).values({
      id,
      workspaceId: run.workspaceId,
      jobId: run.jobId ?? null,
      installationId: run.installationId,
      repoFullName: run.repoFullName,
      pullNumber: run.pullNumber,
      headSha: run.headSha,
      status: run.status,
      costUsd: run.costUsd !== null ? String(run.costUsd) : null,
      detail: run.detail,
      createdAt,
      finishedAt: null,
      provider: run.provider ?? null,
      model: run.model ?? null,
      effort: run.effort ?? null,
      fallbackFrom: run.fallbackFrom ?? null,
      findingsCount: run.findingsCount ?? null,
      result: run.result ?? null,
      reviewUrl: run.reviewUrl ?? null,
    });
    return {
      ...run,
      id,
      costUsd: run.costUsd !== null ? Number(run.costUsd) : null,
      createdAt,
      finishedAt: null,
    };
  });
}

export async function finishPgReviewRun(
  db: AppDb,
  workspaceId: string,
  id: string,
  result: FinishReviewRunOptions,
): Promise<void> {
  const updateValues: Record<string, unknown> = {
    status: result.status,
    costUsd: result.costUsd !== null ? String(result.costUsd) : null,
    detail: result.detail,
    finishedAt: new Date(),
  };
  if (result.provider !== undefined) updateValues.provider = result.provider;
  if (result.model !== undefined) updateValues.model = result.model;
  if (result.effort !== undefined) updateValues.effort = result.effort;
  if (result.fallbackFrom !== undefined) updateValues.fallbackFrom = result.fallbackFrom;
  if (result.findingsCount !== undefined) updateValues.findingsCount = result.findingsCount;
  if (result.result !== undefined) updateValues.result = result.result;
  if (result.reviewUrl !== undefined) updateValues.reviewUrl = result.reviewUrl;

  await db
    .update(reviewRuns)
    .set(updateValues)
    .where(and(eq(reviewRuns.id, id), eq(reviewRuns.workspaceId, workspaceId)));
}

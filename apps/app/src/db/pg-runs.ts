import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  ActiveRunExistsError,
  REUSABLE_RUN_STATUSES,
  type LatestFailedRunsOptions,
  type ListReviewRunsOptions,
  type ListReviewRunsResult,
  type NewReviewRun,
  type ReviewRun,
  type ReviewRunResultPayload,
  type ReviewRunStatus,
} from '../core/types.js';
import { runFilterConditions, runSortOrder } from './pg-run-filters.js';
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
    updatedAt: new Date(row.updatedAt),
    provider: row.provider ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    fallbackFrom: row.fallbackFrom ?? null,
    findingsCount: row.findingsCount !== null ? Number(row.findingsCount) : null,
    result: (row.result as ReviewRunResultPayload | null) ?? null,
    reviewUrl: row.reviewUrl ?? null,
    botSlot: Number(row.botSlot ?? 1),
    botName: row.botName ?? null,
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
  const whereClause = and(...runFilterConditions(workspaceId, opts));

  const countRows = await db
    .select({ count: sql<string>`count(*)` })
    .from(reviewRuns)
    .where(whereClause);
  const total = Number(countRows[0]?.count ?? 0);

  const primaryOrder = runSortOrder(reviewRuns, opts.sort, opts.dir);
  const tieBreaker = opts.dir === 'asc' ? asc(reviewRuns.id) : desc(reviewRuns.id);

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

export async function touchPgReviewRun(db: AppDb, workspaceId: string, id: string): Promise<void> {
  await db
    .update(reviewRuns)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(reviewRuns.id, id),
        eq(reviewRuns.workspaceId, workspaceId),
        inArray(reviewRuns.status, ['running', 'queued']),
      ),
    );
}

/** Columns a new run (or a retry reusing a queued/running/failed run of the same job) starts with. */
function startingValues(run: NewReviewRun, now: Date) {
  return {
    headSha: run.headSha,
    status: run.status,
    costUsd: run.costUsd !== null ? String(run.costUsd) : null,
    detail: run.detail,
    finishedAt: null,
    updatedAt: now,
    provider: run.provider ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    fallbackFrom: run.fallbackFrom ?? null,
    findingsCount: run.findingsCount ?? null,
    result: run.result ?? null,
    reviewUrl: run.reviewUrl ?? null,
    botSlot: run.botSlot ?? 1,
    botName: run.botName ?? null,
  };
}

/** Name of the partial unique index of migrations 0004/0009 (one queued/running run per head and bot). */
export const ACTIVE_RUN_INDEX = 'idx_review_runs_active_pr_head';

/** True when `error` (or a driver error it wraps) is a unique violation of ACTIVE_RUN_INDEX. */
export function isActiveRunConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const fields = current as Error & { code?: unknown; constraint?: unknown };
    if (
      fields.code === '23505' &&
      (fields.constraint === ACTIVE_RUN_INDEX || fields.message.includes(ACTIVE_RUN_INDEX))
    ) {
      return true;
    }
    current = fields.cause;
  }
  return false;
}

export async function createPgReviewRun(db: AppDb, run: NewReviewRun): Promise<ReviewRun> {
  try {
    return await insertOrReusePgReviewRun(db, run);
  } catch (error) {
    if (isActiveRunConflict(error)) throw new ActiveRunExistsError(run.repoFullName, run.pullNumber, run.botSlot ?? 1);
    throw error;
  }
}

async function insertOrReusePgReviewRun(db: AppDb, run: NewReviewRun): Promise<ReviewRun> {
  return withLiveWorkspace(db, run.workspaceId, async (tx) => {
    const now = new Date();
    if (run.jobId) {
      // Only a queued/running/failed run of this job and bot is reused; completed and skipped
      // runs stay, and one job's other bots keep their own rows (ADR-0017).
      const reused = await tx
        .update(reviewRuns)
        .set(startingValues(run, now))
        .where(
          and(
            eq(reviewRuns.workspaceId, run.workspaceId),
            eq(reviewRuns.jobId, run.jobId),
            eq(reviewRuns.botSlot, run.botSlot ?? 1),
            inArray(reviewRuns.status, [...REUSABLE_RUN_STATUSES]),
          ),
        )
        .returning();
      if (reused[0]) return mapReviewRunRow(reused[0]);
    }
    const inserted = await tx
      .insert(reviewRuns)
      .values({
        ...startingValues(run, now),
        id: randomUUID(),
        workspaceId: run.workspaceId,
        jobId: run.jobId ?? null,
        installationId: run.installationId,
        repoFullName: run.repoFullName,
        pullNumber: run.pullNumber,
        createdAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('review run insert returned no row');
    return mapReviewRunRow(row);
  });
}

export async function findPgActiveReviewRun(
  db: AppDb,
  workspaceId: string,
  repoFullName: string,
  pullNumber: number,
  headSha: string,
  botSlot?: number,
): Promise<ReviewRun | null> {
  const rows = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.workspaceId, workspaceId),
        eq(reviewRuns.repoFullName, repoFullName),
        eq(reviewRuns.pullNumber, pullNumber),
        eq(reviewRuns.headSha, headSha),
        inArray(reviewRuns.status, ['queued', 'running']),
        botSlot === undefined ? undefined : eq(reviewRuns.botSlot, botSlot),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? mapReviewRunRow(row) : null;
}

export async function listPgLatestFailedRuns(
  db: AppDb,
  workspaceId: string,
  options?: LatestFailedRunsOptions,
): Promise<ReviewRun[]> {
  const limit = options?.limit ?? 25;
  // Rank ALL of a PR's runs (the repo filter only narrows whole partitions); the date window is
  // applied to the latest row afterwards, so a PR that failed inside the window but later
  // completed is not picked.
  const conditions = [eq(reviewRuns.workspaceId, workspaceId)];
  if (options?.repo && options.repo.length > 0) {
    conditions.push(inArray(reviewRuns.repoFullName, options.repo));
  }

  const ranked = db
    .select({
      id: reviewRuns.id,
      workspaceId: reviewRuns.workspaceId,
      jobId: reviewRuns.jobId,
      installationId: reviewRuns.installationId,
      repoFullName: reviewRuns.repoFullName,
      pullNumber: reviewRuns.pullNumber,
      headSha: reviewRuns.headSha,
      status: reviewRuns.status,
      costUsd: reviewRuns.costUsd,
      detail: reviewRuns.detail,
      createdAt: reviewRuns.createdAt,
      finishedAt: reviewRuns.finishedAt,
      updatedAt: reviewRuns.updatedAt,
      provider: reviewRuns.provider,
      model: reviewRuns.model,
      effort: reviewRuns.effort,
      fallbackFrom: reviewRuns.fallbackFrom,
      findingsCount: reviewRuns.findingsCount,
      result: reviewRuns.result,
      reviewUrl: reviewRuns.reviewUrl,
      botSlot: reviewRuns.botSlot,
      botName: reviewRuns.botName,
      rn: sql<number>`row_number() over (partition by ${reviewRuns.repoFullName}, ${reviewRuns.pullNumber} order by ${reviewRuns.createdAt} desc, ${reviewRuns.id} desc)`.as('rn'),
    })
    .from(reviewRuns)
    .where(and(...conditions))
    .as('ranked');

  const outer = [eq(ranked.rn, 1), eq(ranked.status, 'failed')];
  if (options?.from) outer.push(gte(ranked.createdAt, options.from));
  if (options?.to) outer.push(lte(ranked.createdAt, options.to));

  const rows = await db
    .select()
    .from(ranked)
    .where(and(...outer))
    .orderBy(desc(ranked.createdAt), desc(ranked.id))
    .limit(limit);

  return rows.map((r) => mapReviewRunRow(r as typeof reviewRuns.$inferSelect));
}

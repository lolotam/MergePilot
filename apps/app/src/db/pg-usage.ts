import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FinishReviewRunOptions, ReviewRunStatus } from '../core/types.js';
import { FINISHED_RUN_STATUSES, usageMonth, type MonthlyUsage } from '../core/run-types.js';
import type { AppDb } from './pg-store.js';
import { reviewRuns, workspaceUsageMonthly } from './schema.js';
import type { PgBase } from './workspace-lock.js';

interface UsageDelta {
  workspaceId: string;
  month: string;
  runsTotal: number;
  runsCompleted: number;
  runsFailed: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function deltaFor(
  workspaceId: string,
  createdAt: Date,
  status: ReviewRunStatus,
  costUsd: number | null,
  usage: { inputTokens: number; outputTokens: number } | undefined,
): UsageDelta {
  return {
    workspaceId,
    month: usageMonth(createdAt),
    runsTotal: 1,
    runsCompleted: status === 'completed' ? 1 : 0,
    runsFailed: status === 'failed' ? 1 : 0,
    costUsd: costUsd ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

function negate(d: UsageDelta): UsageDelta {
  return {
    ...d,
    runsTotal: -d.runsTotal,
    runsCompleted: -d.runsCompleted,
    runsFailed: -d.runsFailed,
    costUsd: -d.costUsd,
    inputTokens: -d.inputTokens,
    outputTokens: -d.outputTokens,
  };
}

/** Adds one delta to the month's summary row (insert, or add to the existing counters). */
async function addUsage(tx: PgBase, d: UsageDelta): Promise<void> {
  const t = workspaceUsageMonthly;
  await tx
    .insert(t)
    .values({ ...d, costUsd: d.costUsd.toFixed(6) })
    .onConflictDoUpdate({
      target: [t.workspaceId, t.month],
      set: {
        runsTotal: sql`${t.runsTotal} + excluded.runs_total`,
        runsCompleted: sql`${t.runsCompleted} + excluded.runs_completed`,
        runsFailed: sql`${t.runsFailed} + excluded.runs_failed`,
        costUsd: sql`${t.costUsd} + excluded.cost_usd`,
        inputTokens: sql`${t.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${t.outputTokens} + excluded.output_tokens`,
      },
    });
}

/** Finishes a run and, for a finished status, adds it to the monthly usage in the same transaction. */
export async function finishPgReviewRun(
  db: AppDb,
  workspaceId: string,
  id: string,
  result: FinishReviewRunOptions,
): Promise<void> {
  const now = new Date();
  const updateValues: Partial<typeof reviewRuns.$inferInsert> = {
    status: result.status,
    costUsd: result.costUsd !== null ? String(result.costUsd) : null,
    detail: result.detail,
    finishedAt: now,
    updatedAt: now,
  };
  if (result.provider !== undefined) updateValues.provider = result.provider;
  if (result.model !== undefined) updateValues.model = result.model;
  if (result.effort !== undefined) updateValues.effort = result.effort;
  if (result.fallbackFrom !== undefined) updateValues.fallbackFrom = result.fallbackFrom;
  if (result.findingsCount !== undefined) updateValues.findingsCount = result.findingsCount;
  if (result.result !== undefined) updateValues.result = result.result;
  if (result.reviewUrl !== undefined) updateValues.reviewUrl = result.reviewUrl;

  const pg: PgBase = db;
  await pg.transaction(async (tx) => {
    // A run finished twice (e.g. failed by the stale sweep, then finished by its worker) replaces
    // its earlier usage instead of counting twice.
    const before = await tx
      .select({ status: reviewRuns.status, finishedAt: reviewRuns.finishedAt, costUsd: reviewRuns.costUsd, result: reviewRuns.result, createdAt: reviewRuns.createdAt })
      .from(reviewRuns)
      .where(and(eq(reviewRuns.id, id), eq(reviewRuns.workspaceId, workspaceId)))
      .for('update');
    const prior = before[0];
    // Only a run that was finished before (finishedAt set) was counted; one created finished was not.
    if (prior?.finishedAt && FINISHED_RUN_STATUSES.includes(prior.status as ReviewRunStatus)) {
      const usage = (prior.result as { usage?: { inputTokens: number; outputTokens: number } } | null)?.usage;
      const d = deltaFor(workspaceId, new Date(prior.createdAt), prior.status as ReviewRunStatus, prior.costUsd === null ? null : Number(prior.costUsd), usage);
      await addUsage(tx, negate(d));
    }
    const rows = await tx
      .update(reviewRuns)
      .set(updateValues)
      .where(and(eq(reviewRuns.id, id), eq(reviewRuns.workspaceId, workspaceId)))
      .returning({ createdAt: reviewRuns.createdAt });
    const row = rows[0];
    if (!row || !FINISHED_RUN_STATUSES.includes(result.status)) return;
    await addUsage(
      tx,
      deltaFor(workspaceId, new Date(row.createdAt), result.status, result.costUsd, result.result?.usage),
    );
  });
}

/** Fails stale queued/running runs; each one counts as a failed run in its month's usage. */
export async function failPgStaleRuns(db: AppDb, heartbeatBefore: Date): Promise<number> {
  const now = new Date();
  const pg: PgBase = db;
  return pg.transaction(async (tx) => {
    const failed = await tx
      .update(reviewRuns)
      .set({ status: 'failed', detail: 'interrupted', finishedAt: now, updatedAt: now })
      .where(
        and(
          inArray(reviewRuns.status, ['running', 'queued']),
          lt(reviewRuns.updatedAt, heartbeatBefore),
        ),
      )
      .returning({ workspaceId: reviewRuns.workspaceId, createdAt: reviewRuns.createdAt });
    const byMonth = new Map<string, UsageDelta>();
    for (const r of failed) {
      const d = deltaFor(r.workspaceId, new Date(r.createdAt), 'failed', null, undefined);
      const key = `${d.workspaceId}\u0000${d.month}`;
      const prev = byMonth.get(key);
      byMonth.set(key, prev ? { ...prev, runsTotal: prev.runsTotal + 1, runsFailed: prev.runsFailed + 1 } : d);
    }
    for (const d of byMonth.values()) await addUsage(tx, d);
    return failed.length;
  });
}

export async function monthPgCostUsd(db: AppDb, workspaceId: string, monthStart: Date): Promise<number> {
  const t = workspaceUsageMonthly;
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${t.costUsd}), 0)` })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), gte(t.month, usageMonth(monthStart))));
  return Number(rows[0]?.total ?? '0');
}

export async function listPgMonthlyUsage(db: AppDb, workspaceId: string): Promise<MonthlyUsage[]> {
  const t = workspaceUsageMonthly;
  const rows = await db.select().from(t).where(eq(t.workspaceId, workspaceId)).orderBy(asc(t.month));
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    month: String(r.month),
    runsTotal: Number(r.runsTotal),
    runsCompleted: Number(r.runsCompleted),
    runsFailed: Number(r.runsFailed),
    costUsd: Number(r.costUsd),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
  }));
}

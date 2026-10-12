import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_RUN_RETENTION_DAYS,
  FINISHED_RUN_STATUSES,
  RunCountMismatchError,
  RunsNotFoundError,
  type DeleteRunsTarget,
  type MaintenanceKind,
  type MaintenanceRun,
  type RetentionPolicy,
} from '../core/run-types.js';
import { runFilterConditions } from './pg-run-filters.js';
import type { AppDb } from './pg-store.js';
import { maintenanceRuns, reviewRuns, workspaceSettings } from './schema.js';
import { withLiveWorkspace, type PgBase } from './workspace-lock.js';

const finished = () => inArray(reviewRuns.status, [...FINISHED_RUN_STATUSES]);

/** Bulk delete under the live-workspace lock; the checks and the delete are one transaction. */
export async function deletePgReviewRuns(
  db: AppDb,
  workspaceId: string,
  target: DeleteRunsTarget,
): Promise<number> {
  return withLiveWorkspace(db, workspaceId, async (lockedTx) => {
    const tx: PgBase = lockedTx;
    if ('ids' in target) {
      const ids = [...new Set(target.ids)];
      if (ids.length === 0) return 0;
      const inWorkspace = and(eq(reviewRuns.workspaceId, workspaceId), inArray(reviewRuns.id, ids));
      const found = await tx.select({ n: sql<string>`count(*)` }).from(reviewRuns).where(inWorkspace);
      if (Number(found[0]?.n ?? 0) !== ids.length) throw new RunsNotFoundError();
      const deleted = await tx.delete(reviewRuns).where(and(inWorkspace, finished())).returning({ id: reviewRuns.id });
      return deleted.length;
    }
    const matching = and(...runFilterConditions(workspaceId, target.filters));
    const counted = await tx.select({ n: sql<string>`count(*)` }).from(reviewRuns).where(matching);
    const actual = Number(counted[0]?.n ?? 0);
    if (actual !== target.expectedCount) throw new RunCountMismatchError(actual);
    const deleted = await tx.delete(reviewRuns).where(and(matching, finished())).returning({ id: reviewRuns.id });
    return deleted.length;
  });
}

/** Workspaces that have runs, with their retention; no settings row means the default. */
export async function listPgRetentionPolicies(db: AppDb): Promise<RetentionPolicy[]> {
  const rows = await db
    .selectDistinct({
      workspaceId: reviewRuns.workspaceId,
      configured: sql<boolean>`${workspaceSettings.workspaceId} IS NOT NULL`,
      days: workspaceSettings.runRetentionDays,
    })
    .from(reviewRuns)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, reviewRuns.workspaceId))
    .orderBy(asc(reviewRuns.workspaceId));
  const policies: RetentionPolicy[] = [];
  for (const row of rows) {
    const days = row.configured ? row.days : DEFAULT_RUN_RETENTION_DAYS;
    if (days !== null && days > 0) policies.push({ workspaceId: row.workspaceId, retentionDays: days });
  }
  return policies;
}

/** One retention batch: up to `limit` finished runs created before the cutoff, oldest first. */
export async function prunePgReviewRuns(
  db: AppDb,
  workspaceId: string,
  createdBefore: Date,
  limit: number,
): Promise<number> {
  const batch = db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(and(eq(reviewRuns.workspaceId, workspaceId), finished(), lt(reviewRuns.createdAt, createdBefore)))
    .orderBy(asc(reviewRuns.createdAt))
    .limit(limit);
  const pg: PgBase = db;
  const deleted = await pg
    .delete(reviewRuns)
    .where(and(eq(reviewRuns.workspaceId, workspaceId), inArray(reviewRuns.id, batch)))
    .returning({ id: reviewRuns.id });
  return deleted.length;
}

function mapMaintenanceRow(row: typeof maintenanceRuns.$inferSelect): MaintenanceRun {
  return {
    id: row.id,
    kind: row.kind as MaintenanceKind,
    startedAt: new Date(row.startedAt),
    finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    deletedCount: Number(row.deletedCount),
    error: row.error ?? null,
  };
}

/**
 * Takes the job lease. The partial unique index (one unfinished run per kind) makes the insert
 * fail for a second taker; ON CONFLICT DO NOTHING turns that into "no row" (lease held).
 */
export async function startPgMaintenanceRun(
  db: AppDb,
  kind: MaintenanceKind,
  staleBefore: Date,
): Promise<MaintenanceRun | null> {
  const now = new Date();
  await db
    .update(maintenanceRuns)
    .set({ finishedAt: now, error: 'abandoned' })
    .where(and(eq(maintenanceRuns.kind, kind), isNull(maintenanceRuns.finishedAt), lt(maintenanceRuns.startedAt, staleBefore)));
  const inserted = await db
    .insert(maintenanceRuns)
    .values({ id: randomUUID(), kind, startedAt: now })
    .onConflictDoNothing()
    .returning();
  return inserted[0] ? mapMaintenanceRow(inserted[0]) : null;
}

export async function finishPgMaintenanceRun(
  db: AppDb,
  id: string,
  result: { deletedCount: number; error: string | null },
): Promise<void> {
  await db
    .update(maintenanceRuns)
    .set({ finishedAt: new Date(), deletedCount: result.deletedCount, error: result.error })
    .where(eq(maintenanceRuns.id, id));
}

export async function getLatestPgMaintenanceRun(db: AppDb, kind: MaintenanceKind): Promise<MaintenanceRun | null> {
  const rows = await db
    .select()
    .from(maintenanceRuns)
    .where(eq(maintenanceRuns.kind, kind))
    .orderBy(desc(maintenanceRuns.startedAt))
    .limit(1);
  return rows[0] ? mapMaintenanceRow(rows[0]) : null;
}

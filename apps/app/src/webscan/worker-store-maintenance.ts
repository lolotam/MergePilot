import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import { webScanFindings, webScans } from '../db/schema.js';
import { appendAudit } from './pg-audit.js';
import type {
  WebScanOutboxEntry,
  WebScanPruneInput,
} from './worker-store.js';
import type { WebScanOutboxState } from './types.js';

/**
 * The maintenance persistence of the scanner: the outbox, the reconciliation of the
 * orphaned attempts and the pruning of the expired snapshots.
 *
 * These are the operations that run outside a scan. They share the transactional and
 * audit helpers of the shared store, so every state they write is audited.
 */

/** Lists the queued scans whose outbox record is in one of the given states. */
export async function listOutboxScans(
  db: AppDb,
  limit: number,
  states: readonly WebScanOutboxState[],
): Promise<WebScanOutboxEntry[]> {
  const rows = await db
    .select({
      id: webScans.id,
      siteId: webScans.siteId,
      trigger: webScans.trigger,
      scheduledFor: webScans.scheduledFor,
      outboxState: webScans.outboxState,
      createdAt: webScans.createdAt,
    })
    .from(webScans)
    .where(and(eq(webScans.status, 'queued'), inArray(webScans.outboxState, [...states])))
    .orderBy(asc(webScans.createdAt))
    .limit(Math.max(1, limit));

  return rows.map((row) => ({
    scanId: row.id,
    siteId: row.siteId,
    trigger: row.trigger === 'manual' ? 'manual' : 'scheduled',
    scheduledFor: row.scheduledFor,
    outboxState: row.outboxState as WebScanOutboxState,
    createdAt: row.createdAt,
  }));
}

/** Lists the running attempts whose heartbeat is stale. */
export async function listStaleRunningScans(
  db: AppDb,
  input: { staleBefore: Date; limit: number },
): Promise<WebScanOutboxEntry[]> {
  const rows = await db
    .select({
      id: webScans.id,
      siteId: webScans.siteId,
      trigger: webScans.trigger,
      scheduledFor: webScans.scheduledFor,
      outboxState: webScans.outboxState,
      createdAt: webScans.createdAt,
    })
    .from(webScans)
    .where(
      and(
        eq(webScans.status, 'running'),
        or(isNull(webScans.heartbeatAt), lt(webScans.heartbeatAt, input.staleBefore)),
      ),
    )
    .orderBy(asc(webScans.createdAt))
    .limit(Math.max(1, input.limit));

  return rows.map((row) => ({
    scanId: row.id,
    siteId: row.siteId,
    trigger: row.trigger === 'manual' ? 'manual' : 'scheduled',
    scheduledFor: row.scheduledFor,
    outboxState: row.outboxState as WebScanOutboxState,
    createdAt: row.createdAt,
  }));
}

/** Marks the given orphaned running attempts failed. */
export async function failOrphanedAttempts(
  db: AppDb,
  input: { scanIds: readonly string[]; staleBefore: Date; now: Date },
): Promise<number> {
  if (input.scanIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    // Only a running attempt with a stale heartbeat is orphaned. A queued scan has no
    // attempt and is never touched here.
    const updated = await tx
      .update(webScans)
      .set({
        status: 'failed',
        failReason: 'worker_lost',
        finishedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(webScans.status, 'running'),
          inArray(webScans.id, [...input.scanIds]),
          or(isNull(webScans.heartbeatAt), lt(webScans.heartbeatAt, input.staleBefore)),
        ),
      )
      .returning();

    for (const row of updated) {
      await appendAudit(tx, {
        actor: 'worker:reconciliation',
        action: 'scan.worker_lost',
        targetType: 'scan',
        targetId: row.id,
        after: { status: 'failed', failReason: 'worker_lost' },
      });
    }

    return updated.length;
  });
}

/**
 * Marks an outbox record as published.
 *
 * The state change and its audit row share one transaction, so the outbox never shows
 * a published record without a record of when it was published.
 */
export async function markOutboxPublished(
  db: AppDb,
  input: { scanId: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(webScans)
      .set({ outboxState: 'published', outboxPublishedAt: input.now, updatedAt: input.now })
      .where(and(eq(webScans.id, input.scanId), inArray(webScans.outboxState, ['pending', 'unknown'])))
      .returning();
    if (updated.length === 0) return false;

    await appendAudit(tx, {
      actor: 'worker:outbox',
      action: 'scan.outbox',
      targetType: 'scan',
      targetId: input.scanId,
      after: { outboxState: 'published' },
    });

    return true;
  });
}

/**
 * Marks an outbox record as unknown, so it is published again later.
 *
 * The state change and its audit row share one transaction.
 */
export async function markOutboxUnknown(
  db: AppDb,
  input: { scanId: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(webScans)
      .set({ outboxState: 'unknown', updatedAt: input.now })
      .where(and(eq(webScans.id, input.scanId), eq(webScans.outboxState, 'pending')))
      .returning();
    if (updated.length === 0) return false;

    await appendAudit(tx, {
      actor: 'worker:outbox',
      action: 'scan.outbox',
      targetType: 'scan',
      targetId: input.scanId,
      after: { outboxState: 'unknown' },
    });

    return true;
  });
}

/**
 * Deletes the expired scan snapshots, keeping the last completed scan of every site.
 *
 * The last completed scan of a site is its comparison baseline: deleting it would
 * leave the site without a baseline and would reset the comparison of the next scan.
 */
export async function pruneExpiredScans(db: AppDb, input: WebScanPruneInput): Promise<number> {
  return db.transaction(async (tx) => {
    const limit = Math.max(1, input.limit);

    const candidates = await tx
      .select({ id: webScans.id, siteId: webScans.siteId })
      .from(webScans)
      .where(
        and(
          lt(webScans.createdAt, input.olderThan),
          inArray(webScans.status, ['completed', 'stopped', 'failed']),
        ),
      )
      .orderBy(asc(webScans.createdAt))
      .limit(limit);
    if (candidates.length === 0) return 0;

    const siteIds = [...new Set(candidates.map((candidate) => candidate.siteId))];
    const baselines = await tx
      .select({ id: webScans.id, siteId: webScans.siteId })
      .from(webScans)
      .where(and(eq(webScans.status, 'completed'), inArray(webScans.siteId, siteIds)))
      .orderBy(desc(webScans.createdAt));
    const baselineBySite = new Map<string, string>();
    for (const baseline of baselines) {
      if (!baselineBySite.has(baseline.siteId)) {
        baselineBySite.set(baseline.siteId, baseline.id);
      }
    }

    const expired = candidates
      .filter((candidate) => baselineBySite.get(candidate.siteId) !== candidate.id)
      .map((candidate) => candidate.id)
      .slice(0, limit);
    if (expired.length === 0) return 0;

    // The findings and the evidence of the scan go with it.
    await tx.delete(webScanFindings).where(inArray(webScanFindings.scanId, expired));
    const deleted = await tx
      .delete(webScans)
      .where(inArray(webScans.id, expired))
      .returning();

    const first = expired[0];
    await appendAudit(tx, {
      actor: 'worker:retention',
      action: 'scan.prune',
      targetType: 'scan',
      targetId: first ?? '',
      after: { pruned: deleted.length },
    });

    return deleted.length;
  });
}

/** Appends the audit summary of a maintenance pass. */
export async function appendAuditSummary(
  db: AppDb,
  input: {
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    after: unknown;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await appendAudit(tx, {
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      after: input.after,
    });
  });
}

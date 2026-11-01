import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type {
  OccurrenceFinding,
  RetainedOccurrence,
  RetainedOccurrenceIdentity,
} from '@mergepilot/webscan';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { webScanOccurrences, webScans } from '../db/schema.js';
import { appendAudit, WEB_SCAN_MAINTENANCE_ACTOR } from './pg-audit.js';
import { findLiveExceptionForOccurrence } from './pg-exceptions.js';
import { lockSiteRow, toWebScanOccurrence, type OccurrenceRow } from './pg-rows.js';
import { lockSettingsRow } from './pg-settings.js';
import type { WebScanOccurrenceUpdate } from './store.js';
import type { WebScanOccurrence } from './types.js';

/**
 * The retained ledger of the scanner (ADR-0052 section 11).
 *
 * The ledger survives the expiry of the scan snapshots: it holds the latest state of
 * every occurrence of a site. An occurrence that was never proven fixed may become a
 * tombstone, but only after the retention horizon elapsed and only when no completed
 * scan evaluated it since.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The interval of a schedule, used by the retention horizon. */
export function scheduleIntervalMs(
  schedule: { frequency: string; enabled?: boolean } | null,
): number {
  if (schedule === null || schedule.enabled === false) return DAY_MS;
  switch (schedule.frequency) {
    case 'daily':
      return DAY_MS;
    case 'weekly':
      return 7 * DAY_MS;
    case 'biweekly':
      return 14 * DAY_MS;
    case 'monthly':
      // The approximation of a month. A month of 28 to 31 days is used as 30, so a
      // monthly site with a short retention can put a February identity outside the
      // horizon. The horizon is the retention period in almost every installation, and
      // this only ever widens the archive, never the prune.
      return 30 * DAY_MS;
    default:
      return DAY_MS;
  }
}

/** The retention horizon of a site: the retention period or the schedule interval plus a day. */
export function retentionHorizonMs(
  retentionDays: number,
  schedule: { frequency: string; enabled?: boolean } | null,
): number {
  return Math.max(retentionDays * DAY_MS, scheduleIntervalMs(schedule) + DAY_MS);
}

/** The rows of the ledger of one site. */
export async function listOccurrenceRows(db: AppDb, siteId: string): Promise<OccurrenceRow[]> {
  return db.select().from(webScanOccurrences).where(eq(webScanOccurrences.siteId, siteId));
}

/** The ledger of one site, in the shape the comparison needs. */
export async function listRetainedOccurrences(
  db: AppDb,
  siteId: string,
): Promise<RetainedOccurrence[]> {
  const rows = await listOccurrenceRows(db, siteId);
  return rows.map(toRetainedOccurrence);
}

/** Maps one ledger row onto the retained shape of the package. */
export function toRetainedOccurrence(row: OccurrenceRow): RetainedOccurrence {
  const identity: RetainedOccurrenceIdentity = {
    occurrenceKey: row.occurrenceKey,
    targetKey: row.targetKey,
    checkId: row.checkId as RetainedOccurrenceIdentity['checkId'],
    checkVersion: row.checkVersion,
    issueKey: row.issueKey,
    issueId: row.issueId,
    subject: row.subject,
    severity: row.severity as RetainedOccurrenceIdentity['severity'],
    validation: row.validation as RetainedOccurrenceIdentity['validation'],
    confidence: row.confidence as RetainedOccurrenceIdentity['confidence'],
    safeLocation: row.safeLocation,
    evidenceHash: row.evidenceHash,
  };

  if (row.state === 'archived') {
    const archived = row.archiveReason ?? 'unobserved_retention';
    return {
      identity,
      state: 'archived',
      archiveReason: archived as Extract<RetainedOccurrence, { state: 'archived' }>['archiveReason'],
    };
  }

  const finding: OccurrenceFinding = {
    ...identity,
    evidence: (row.evidence as OccurrenceFinding['evidence']) ?? null,
  };
  return { finding, state: row.state === 'fixed' ? 'fixed' : 'outstanding' };
}

/** The ledger of one site, in the app domain shape. */
export async function listOccurrences(db: AppDb, siteId: string): Promise<WebScanOccurrence[]> {
  const rows = await listOccurrenceRows(db, siteId);
  return rows.map(toWebScanOccurrence);
}

/**
 * Applies the transitions of a comparison to the ledger.
 *
 * The write is an upsert on the site and the occurrence key, so the ledger holds one
 * row per occurrence of a site no matter how often it is observed.
 *
 * Only a completed scan may prove an occurrence fixed. A stopped or a failed run is not
 * a baseline, so it never turns an identity into a proven one and never writes the
 * scan that would have proven it.
 */
export async function applyOccurrenceUpdates(
  tx: AppTx,
  siteId: string,
  scanId: string,
  updates: readonly WebScanOccurrenceUpdate[],
  options: { now: Date; completed: boolean },
): Promise<void> {
  for (const update of updates) {
    const existing = await readOccurrenceForUpdate(tx, siteId, updateOccurrenceKey(update));

    if (update.state === 'archived') {
      const identity = update.identity;
      const pinned = await findLiveExceptionForOccurrence(
        tx,
        siteId,
        identity.occurrenceKey,
        identity.evidenceHash,
        options.now,
      );
      await upsertOccurrence(tx, {
        siteId,
        occurrenceKey: identity.occurrenceKey,
        targetKey: identity.targetKey,
        issueKey: identity.issueKey,
        checkId: identity.checkId,
        checkVersion: identity.checkVersion,
        issueId: identity.issueId,
        subject: identity.subject,
        severity: identity.severity,
        validation: identity.validation,
        confidence: identity.confidence,
        safeLocation: identity.safeLocation,
        evidenceHash: identity.evidenceHash,
        evidence: null,
        state: 'archived',
        archiveReason: update.archiveReason,
        comparison: 'Not checked',
        lastObservedAt: existing?.lastObservedAt ?? options.now,
        lastCompletedScanId: existing?.lastCompletedScanId ?? null,
        // A tombstone behind an administrator resolution is retained for as long as that
        // resolution exists, so the tombstone is pinned by the resolution that covers it.
        exceptionId: pinned?.id ?? null,
        notificationEpisodeRef: existing?.notificationEpisodeRef ?? null,
      });
      continue;
    }

    // A run that did not complete cannot prove an identity fixed. The transition is
    // refused instead of being written, so a stopped run never prunes anything later.
    if (!options.completed && update.state === 'fixed') {
      continue;
    }

    const finding = update.finding;
    const wasArchived = existing?.state === 'archived';
    const pinned = await findLiveExceptionForOccurrence(
      tx,
      siteId,
      finding.occurrenceKey,
      finding.evidenceHash,
      options.now,
    );
    await upsertOccurrence(tx, {
      siteId,
      occurrenceKey: finding.occurrenceKey,
      targetKey: finding.targetKey,
      issueKey: finding.issueKey,
      checkId: finding.checkId,
      checkVersion: finding.checkVersion,
      issueId: finding.issueId,
      subject: finding.subject,
      severity: finding.severity,
      validation: finding.validation,
      confidence: finding.confidence,
      safeLocation: finding.safeLocation,
      evidenceHash: finding.evidenceHash,
      // A tombstone has no evidence body. A row that still has one keeps it, so a
      // fix never throws away evidence that was never pruned.
      evidence: finding.evidence ?? existing?.evidence ?? null,
      state: update.state,
      // An archived row that is proven fixed keeps its archive reason: it is the
      // record of why it was archived, and it is what makes it prunable.
      archiveReason: wasArchived ? (existing?.archiveReason ?? null) : null,
      comparison: finding.comparison,
      lastObservedAt: update.state === 'outstanding' ? options.now : (existing?.lastObservedAt ?? options.now),
      lastCompletedScanId: options.completed ? scanId : (existing?.lastCompletedScanId ?? null),
      // The resolution that covers the identity as it is observed now. A resolution
      // whose evidence hash no longer matches, or that expired, holds nothing.
      exceptionId: pinned?.id ?? null,
      notificationEpisodeRef: existing?.notificationEpisodeRef ?? null,
    });
  }
}

function updateOccurrenceKey(update: WebScanOccurrenceUpdate): string {
  return update.state === 'archived' ? update.identity.occurrenceKey : update.finding.occurrenceKey;
}

async function readOccurrenceForUpdate(
  tx: AppTx,
  siteId: string,
  occurrenceKey: string,
): Promise<OccurrenceRow | null> {
  const rows = await tx
    .select()
    .from(webScanOccurrences)
    .where(
      and(
        eq(webScanOccurrences.siteId, siteId),
        eq(webScanOccurrences.occurrenceKey, occurrenceKey),
      ),
    )
    .for('update');
  return rows[0] ?? null;
}

async function upsertOccurrence(
  tx: AppTx,
  values: typeof webScanOccurrences.$inferInsert,
): Promise<void> {
  await tx
    .insert(webScanOccurrences)
    .values(values)
    .onConflictDoUpdate({
      target: [webScanOccurrences.siteId, webScanOccurrences.occurrenceKey],
      set: {
        targetKey: values.targetKey,
        issueKey: values.issueKey,
        checkId: values.checkId,
        checkVersion: values.checkVersion,
        issueId: values.issueId,
        subject: values.subject,
        severity: values.severity,
        validation: values.validation,
        confidence: values.confidence,
        safeLocation: values.safeLocation,
        evidenceHash: values.evidenceHash,
        evidence: values.evidence,
        state: values.state,
        archiveReason: values.archiveReason,
        comparison: values.comparison,
        lastObservedAt: values.lastObservedAt,
        lastCompletedScanId: values.lastCompletedScanId,
        exceptionId: values.exceptionId,
        notificationEpisodeRef: values.notificationEpisodeRef,
        updatedAt: new Date(),
      },
    });
}

/**
 * Archives the occurrences that may become tombstones.
 *
 * An occurrence is archived only when the retention horizon elapsed since its last
 * observation and no completed scan of the site evaluated its exact target and issue
 * id with a `checked` coverage outcome since then. A paused run, a stopped run, a
 * failure and a kill-switch window are not opportunities: only a completed scan
 * counts.
 */
export async function archiveUnprovenOccurrences(db: AppDb, siteId: string): Promise<number> {
  return db.transaction(async (tx) => {
    // The lock order is settings, then site, then the ledger. See pg-lock-order.ts.
    const settings = await lockSettingsRow(tx);
    const site = await lockSiteRow(tx, siteId);
    if (site === null) return 0;

    const horizonMs = retentionHorizonMs(settings.retentionDays, site.schedule);
    const now = new Date();

    const rows = await tx
      .select()
      .from(webScanOccurrences)
      .where(eq(webScanOccurrences.siteId, siteId))
      .for('update');

    const completedScans = await tx
      .select({
        coverage: webScans.coverageSummary,
        finishedAt: webScans.finishedAt,
      })
      .from(webScans)
      .where(and(eq(webScans.siteId, siteId), eq(webScans.status, 'completed')));

    // The coverage the site retained outlives the snapshot it was produced by, so an
    // evaluation that only the retained coverage knows about still counts.
    const evaluations = [
      ...completedScans,
      ...(site.lastCoverageSummary !== null && site.lastCoverageAt !== null
        ? [{ coverage: site.lastCoverageSummary, finishedAt: site.lastCoverageAt }]
        : []),
    ];

    let archived = 0;
    for (const row of rows) {
      if (row.state !== 'outstanding') continue;
      if (now.getTime() - row.lastObservedAt.getTime() < horizonMs) continue;
      if (wasEvaluatedSince(evaluations, row, row.lastObservedAt)) continue;

      // A tombstone behind an administrator resolution is retained for as long as that
      // resolution exists, so the tombstone is pinned by the resolution that covers it.
      const pinned = await findLiveExceptionForOccurrence(
        tx,
        siteId,
        row.occurrenceKey,
        row.evidenceHash,
        now,
      );

      await tx
        .update(webScanOccurrences)
        .set({
          state: 'archived',
          archiveReason: 'unobserved_retention',
          evidence: null,
          comparison: 'Not checked',
          exceptionId: pinned?.id ?? null,
          updatedAt: now,
        })
        .where(eq(webScanOccurrences.id, row.id));
      archived++;
    }

    // The state change and its audit row share this transaction: a tombstone never
    // exists without a record of why it was archived.
    if (archived > 0) {
      await appendAudit(tx, {
        actor: WEB_SCAN_MAINTENANCE_ACTOR,
        action: 'occurrence.archive',
        targetType: 'site',
        targetId: siteId,
        after: { archived },
      });
    }

    return archived;
  });
}

/**
 * Whether a completed scan evaluated the exact target and issue id of an occurrence
 * since it was last observed.
 *
 * Such a scan would have re-observed the occurrence or proven it fixed, so the
 * occurrence is not an unobserved one and must not become a tombstone.
 */
function wasEvaluatedSince(
  completedScans: readonly { coverage: unknown; finishedAt: Date | null }[],
  occurrence: OccurrenceRow,
  since: Date,
): boolean {
  for (const scan of completedScans) {
    if (scan.finishedAt === null || scan.finishedAt.getTime() < since.getTime()) continue;
    const coverage = Array.isArray(scan.coverage) ? scan.coverage : [];
    for (const entry of coverage) {
      const row = entry as {
        targetKey?: string;
        checkId?: string;
        evaluatedIssueIds?: readonly string[];
        outcome?: string;
      };
      if (row.targetKey !== occurrence.targetKey) continue;
      if (row.checkId !== occurrence.checkId) continue;
      if (row.outcome !== 'checked') continue;
      if (!row.evaluatedIssueIds?.includes(occurrence.issueId)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Deletes the tombstones a completed scan proved fixed.
 *
 * A tombstone is pruned only when three things hold at once:
 *
 * - a completed scan proved it Fixed. Only a completed scan may write that proof, so a
 *   stopped or a failed run can never make a tombstone prunable.
 * - no administrator resolution holds it. A resolution never authorizes pruning, not
 *   even when it carries no expiry, because it can be revoked and the row is then
 *   needed to restore the blocker.
 * - its group holds no unresolved archived blocker. The group is the set of occurrences
 *   of one issue key, and an unresolved blocker in it keeps the whole group in place.
 */
export async function pruneProvenFixedTombstones(db: AppDb, siteId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(webScanOccurrences)
      .where(
        and(
          eq(webScanOccurrences.siteId, siteId),
          eq(webScanOccurrences.state, 'fixed'),
          isNotNull(webScanOccurrences.archiveReason),
        ),
      )
      .for('update');

    let pruned = 0;
    for (const row of rows) {
      // The pin of a resolution that is still alive. A resolution that expired or was
      // revoked holds nothing any more.
      const pinned = await findLiveExceptionForOccurrence(
        tx,
        siteId,
        row.occurrenceKey,
        row.evidenceHash,
        now,
      );
      if (pinned !== null) continue;
      if (row.exceptionId !== null) continue;

      // The group of the issue key still holds an unresolved blocker.
      if (await groupHoldsArchivedBlocker(tx, siteId, row.issueKey, row.id)) continue;

      await tx.delete(webScanOccurrences).where(eq(webScanOccurrences.id, row.id));
      pruned++;
    }

    // The deletion and its audit row share this transaction: a row of the retained
    // ledger never disappears without a record of why it was pruned.
    if (pruned > 0) {
      await appendAudit(tx, {
        actor: WEB_SCAN_MAINTENANCE_ACTOR,
        action: 'occurrence.prune',
        targetType: 'site',
        targetId: siteId,
        after: { pruned },
      });
    }

    return pruned;
  });
}

/**
 * Whether the group of one issue key still holds an unresolved archived blocker.
 *
 * The group is the set of occurrences of one issue key on one site, the same grouping
 * the alert episodes use.
 */
async function groupHoldsArchivedBlocker(
  tx: AppTx,
  siteId: string,
  issueKey: string,
  exceptId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: webScanOccurrences.id })
    .from(webScanOccurrences)
    .where(
      and(
        eq(webScanOccurrences.siteId, siteId),
        eq(webScanOccurrences.issueKey, issueKey),
        eq(webScanOccurrences.state, 'archived'),
        sql`${webScanOccurrences.id} <> ${exceptId}`,
      ),
    );
  return rows.length > 0;
}

/** The count of the outstanding occurrences of a site. */
export async function countOutstanding(db: AppDb, siteId: string): Promise<number> {
  const rows = await db
    .select({ id: webScanOccurrences.id })
    .from(webScanOccurrences)
    .where(and(eq(webScanOccurrences.siteId, siteId), eq(webScanOccurrences.state, 'outstanding')));
  return rows.length;
}

/** Removes the ledger of a site. Only the retention job uses it. */
export async function deleteOccurrences(db: AppDb, siteId: string): Promise<number> {
  const rows = await db
    .delete(webScanOccurrences)
    .where(eq(webScanOccurrences.siteId, siteId))
    .returning();
  return rows.length;
}

/** Locks the ledger rows of the given keys. */
export async function lockOccurrences(
  tx: AppTx,
  siteId: string,
  occurrenceKeys: readonly string[],
): Promise<OccurrenceRow[]> {
  if (occurrenceKeys.length === 0) return [];
  return tx
    .select()
    .from(webScanOccurrences)
    .where(
      and(
        eq(webScanOccurrences.siteId, siteId),
        sql`${webScanOccurrences.occurrenceKey} = ANY(${occurrenceKeys})`,
      ),
    )
    .for('update');
}

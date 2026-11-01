import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { webScanExceptions, webScanOccurrences } from '../db/schema.js';
import { appendAudit, WEB_SCAN_MAINTENANCE_ACTOR } from './pg-audit.js';
import { toWebScanException, type ExceptionRow } from './pg-rows.js';
import {
  WebScanNotFoundError,
  type CreateWebScanExceptionInput,
} from './store.js';
import type { WebScanException } from './types.js';

/**
 * The administrator resolutions of the scanner (ADR-0052 section 9).
 *
 * A resolution applies only while the occurrence key and the evidence hash still
 * match, and only while it is neither revoked nor expired. A resolution never
 * authorizes pruning: the tombstone it pins stays until the resolution ends, because
 * the resolution can be revoked and the row is then needed to restore the blocker.
 */

/** The resolutions of a site. */
export async function listExceptions(db: AppDb, siteId: string): Promise<WebScanException[]> {
  const rows = await db
    .select()
    .from(webScanExceptions)
    .where(eq(webScanExceptions.siteId, siteId));
  return rows.map(toWebScanException);
}

/**
 * The resolutions that apply at the given moment.
 *
 * An expired resolution is not live any more, so it is left out even though nobody
 * revoked it.
 */
export async function listLiveExceptions(
  db: AppDb,
  siteId: string,
  at: Date,
): Promise<WebScanException[]> {
  const rows = await db
    .select()
    .from(webScanExceptions)
    .where(
      and(
        eq(webScanExceptions.siteId, siteId),
        isNull(webScanExceptions.revokedAt),
        or(isNull(webScanExceptions.expiresAt), sql`${webScanExceptions.expiresAt} > ${at}`),
      ),
    );
  return rows.map(toWebScanException);
}

/**
 * The live resolution that applies to one occurrence, if any.
 *
 * A resolution applies only while the occurrence key and the evidence hash still match
 * and only while it is neither revoked nor expired. The newest matching resolution wins,
 * so a later decision replaces an earlier one.
 */
export async function findLiveExceptionForOccurrence(
  tx: AppTx,
  siteId: string,
  occurrenceKey: string,
  evidenceHash: string,
  at: Date,
): Promise<ExceptionRow | null> {
  const rows = await tx
    .select()
    .from(webScanExceptions)
    .where(
      and(
        eq(webScanExceptions.siteId, siteId),
        eq(webScanExceptions.occurrenceKey, occurrenceKey),
        eq(webScanExceptions.evidenceHash, evidenceHash),
        isNull(webScanExceptions.revokedAt),
        or(isNull(webScanExceptions.expiresAt), sql`${webScanExceptions.expiresAt} > ${at}`),
      ),
    )
    .orderBy(desc(webScanExceptions.createdAt));
  return rows[0] ?? null;
}

/**
 * Records a resolution.
 *
 * The resolution and its audit row are written together. The occurrence it applies to is
 * pinned by it, so the occurrence survives until the resolution ends: a tombstone behind
 * an administrator resolution is retained for as long as that resolution exists.
 *
 * A resolution always names an identity that was really observed. The occurrence row is
 * locked first, and a resolution of an identity that does not exist is refused: a
 * resolution that pins nothing would be a resolution of a deleted identity, and it would
 * claim to hold back a finding that is not there any more.
 */
export async function createException(
  db: AppDb,
  actor: string,
  input: CreateWebScanExceptionInput,
): Promise<WebScanException> {
  return db.transaction(async (tx) => {
    // The occurrence is locked before the resolution is written. The prune of the
    // tombstones locks the same rows, so the two writers are serialized: a resolution
    // that is committed first is seen by the prune, and the tombstone it holds is
    // never pruned.
    const occurrence = await tx
      .select({ id: webScanOccurrences.id })
      .from(webScanOccurrences)
      .where(
        and(
          eq(webScanOccurrences.siteId, input.siteId),
          eq(webScanOccurrences.occurrenceKey, input.occurrenceKey),
          eq(webScanOccurrences.evidenceHash, input.evidenceHash),
        ),
      )
      .for('update');

    // The identity the resolution names is gone. It was pruned, or it was never
    // observed. The resolution is refused instead of pointing at nothing.
    if (occurrence.length === 0) {
      throw new WebScanNotFoundError('The web scan occurrence');
    }

    const inserted = await tx
      .insert(webScanExceptions)
      .values({
        siteId: input.siteId,
        occurrenceKey: input.occurrenceKey,
        evidenceHash: input.evidenceHash,
        kind: input.kind,
        reasonCategory: input.reasonCategory,
        reason: input.reason,
        expiresAt: input.expiresAt ?? null,
        createdBy: actor,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) {
      throw new Error('The web scan exception was not written');
    }

    // Pin the occurrence, so it is retained for as long as the resolution exists. The
    // pin only lands on the exact identity the resolution was recorded against: a
    // resolution of one evidence hash does not cover a changed one. A resolution that
    // already expired applies to nothing, so it pins nothing.
    const now = new Date();
    const applies = row.expiresAt === null || row.expiresAt.getTime() > now.getTime();
    if (applies) {
      await tx
        .update(webScanOccurrences)
        .set({ exceptionId: row.id, updatedAt: now })
        .where(eq(webScanOccurrences.id, occurrence[0]!.id));
    }

    await appendAudit(tx, {
      actor,
      action: 'exception.create',
      targetType: 'exception',
      targetId: row.id,
      after: {
        siteId: row.siteId,
        occurrenceKey: row.occurrenceKey,
        kind: row.kind,
        reasonCategory: row.reasonCategory,
        expiresAt: row.expiresAt,
      },
    });

    return toWebScanException(row);
  });
}

/**
 * Revokes a resolution.
 *
 * The tombstone it pinned goes back to its unresolved outstanding state, so the
 * finding re-enters the risk and the alert state instead of silently disappearing.
 *
 * The occurrences the resolution pins are locked before the resolution row itself:
 * the lock order of the scanner is settings, site, scan, occurrence, exception.
 */
export async function revokeException(
  db: AppDb,
  actor: string,
  exceptionId: string,
): Promise<WebScanException> {
  return db.transaction(async (tx) => {
    // The occurrences the resolution holds are locked first, so the resolution row is
    // never locked while a lower row of the order is held.
    await lockOccurrencesOfException(tx, exceptionId);

    const rows = await tx
      .select()
      .from(webScanExceptions)
      .where(eq(webScanExceptions.id, exceptionId))
      .for('update');
    const current = rows[0];
    if (current === undefined) {
      throw new WebScanNotFoundError('The web scan exception');
    }

    const now = new Date();
    const updated = await tx
      .update(webScanExceptions)
      .set({ revokedAt: now, revokedBy: actor })
      .where(eq(webScanExceptions.id, exceptionId))
      .returning();
    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan exception was not written');
    }

    await restoreOccurrencesOfException(tx, current, now);

    await appendAudit(tx, {
      actor,
      action: 'exception.revoke',
      targetType: 'exception',
      targetId: exceptionId,
      before: toWebScanException(current),
      after: toWebScanException(row),
    });

    return toWebScanException(row);
  });
}

/**
 * Restores the tombstones whose resolution expired or was revoked.
 *
 * The row goes back to its unresolved outstanding state under the same identity,
 * including the exception-pinned evidence hash. The pruned evidence stays pruned: it
 * is represented as null, never as a fabricated value.
 */
export async function restoreExpiredExceptionOccurrences(
  db: AppDb,
  siteId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const expired = await tx
      .select()
      .from(webScanExceptions)
      .where(
        and(
          eq(webScanExceptions.siteId, siteId),
          or(
            sql`${webScanExceptions.expiresAt} IS NOT NULL AND ${webScanExceptions.expiresAt} <= ${now}`,
            isNotNull(webScanExceptions.revokedAt),
          ),
        ),
      );

    if (expired.length === 0) {
      return 0;
    }

    // The occurrences come before the resolutions in the lock order, so the rows the
    // restorations touch are locked before the resolution rows that drive them.
    const exceptionIds = expired.map((exception) => exception.id);
    await tx
      .select({ id: webScanOccurrences.id })
      .from(webScanOccurrences)
      .where(inArray(webScanOccurrences.exceptionId, exceptionIds))
      .for('update');
    await tx
      .select({ id: webScanExceptions.id })
      .from(webScanExceptions)
      .where(inArray(webScanExceptions.id, exceptionIds))
      .for('update');

    let restored = 0;
    for (const exception of expired) {
      restored += await restoreOccurrencesOfException(tx, exception, now);
    }

    // The restoration and its audit row share this transaction.
    if (restored > 0) {
      await appendAudit(tx, {
        actor: WEB_SCAN_MAINTENANCE_ACTOR,
        action: 'occurrence.restore',
        targetType: 'site',
        targetId: siteId,
        after: { restored, exceptions: exceptionIds.length },
      });
    }

    return restored;
  });
}

/**
 * Locks the occurrences that one resolution holds.
 *
 * The rows are found through the pin of the resolution, so no resolution row has to be
 * read before the lock of the order is respected.
 */
async function lockOccurrencesOfException(tx: AppTx, exceptionId: string): Promise<void> {
  await tx
    .select({ id: webScanOccurrences.id })
    .from(webScanOccurrences)
    .where(eq(webScanOccurrences.exceptionId, exceptionId))
    .for('update');
}

/**
 * Restores the tombstones of one resolution.
 *
 * A tombstone goes back to its unresolved outstanding state under the same identity.
 * The pruned evidence stays pruned: it is represented as null, never as a fabricated
 * value, and every other safe field is kept as it was recorded.
 *
 * A row that a completed scan already proved fixed is not blocking anything any more,
 * so it keeps its state and only loses the pin of the resolution.
 */
async function restoreOccurrencesOfException(
  tx: AppTx,
  exception: ExceptionRow,
  now: Date,
): Promise<number> {
  const restored = await tx
    .update(webScanOccurrences)
    .set({
      state: 'outstanding',
      archiveReason: null,
      exceptionId: null,
      evidence: null,
      comparison: 'Not checked',
      // The restoration starts a new horizon, so the row is not archived again in
      // the same moment it was restored.
      lastObservedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(webScanOccurrences.exceptionId, exception.id),
        eq(webScanOccurrences.state, 'archived'),
      ),
    )
    .returning();

  // The resolution does not apply any more, so it holds no occurrence any more. A row
  // that is still outstanding or that was already proven fixed keeps its state and only
  // loses the pin.
  await tx
    .update(webScanOccurrences)
    .set({ exceptionId: null, updatedAt: now })
    .where(
      and(
        eq(webScanOccurrences.exceptionId, exception.id),
        sql`${webScanOccurrences.state} <> 'archived'`,
      ),
    );

  return restored.length;
}

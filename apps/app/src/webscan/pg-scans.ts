import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { CheckSwitches, ScanScope } from '@mergepilot/webscan';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { webScanSites, webScans } from '../db/schema.js';
import { appendAudit } from './pg-audit.js';
import { lockSiteRow, readScanRow, toWebScanScan } from './pg-rows.js';
import { lockSettingsRow, toWebScanSettings } from './pg-settings.js';
import { nextScheduledRun } from './schedule.js';
import {
  WebScanAuthorizationError,
  WebScanConflictError,
  WebScanNotFoundError,
  WebScanPausedError,
  type EnqueueManualWebScanInput,
  type EnqueueScheduledWebScanInput,
  type EnqueueWebScanResult,
  type StopWebScanResult,
} from './store.js';
import type { WebScanScan, WebScanSchedule } from './types.js';

/**
 * The scans of the scanner (ADR-0052 section 6).
 *
 * The queued intent of a scan and its outbox state are written in the same
 * transaction, so a scan is never queued without a durable record of the queue. The
 * transaction also locks the settings row and re-reads the site, so a request that
 * was built against an older settings or authorization state is refused instead of
 * running with it.
 */

/** The settings a scan runs under. */
export interface EffectiveScanSettings {
  scope: ScanScope;
  limits: ReturnType<typeof toWebScanSettings>['limits'];
  checks: CheckSwitches;
  contact: string;
}

/** Sorts the keys of a value, so two equal values always produce the same text. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

/**
 * The request data of a manual scan: what the administrator asked for.
 *
 * It carries the request only. The settings the scan finally runs under are not part
 * of it: the limits, the checks and the contact of the installation are server side
 * defaults, and they change without the request changing.
 */
export interface ManualScanRequest {
  siteId: string;
  /** The scope the administrator asked for, if they asked for one. */
  scope?: ScanScope | undefined;
  /** The checks the administrator asked for, if they asked for a different set. */
  checks?: CheckSwitches | undefined;
}

/**
 * The fingerprint of the request data of a scan.
 *
 * The same idempotency key with the same request is a replay. The same key with a
 * different request is a conflict: the administrator asked for two different things
 * under one key.
 *
 * The fingerprint covers the request only, never the effective settings. A change of
 * the server side defaults must not turn a replay of the very same request into a
 * conflict. The effective settings are persisted next to the scan, in their own
 * column, so the scan still records the settings it ran under.
 */
export function requestFingerprint(request: ManualScanRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          siteId: request.siteId,
          scope: request.scope ?? null,
          checks: request.checks ?? null,
        }),
      ),
    )
    .digest('hex');
}

/** Stops the queued scans of a site. It runs inside the caller's transaction. */
export async function stopQueuedScansForSite(
  tx: AppTx,
  siteId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(webScans)
    .set({ status: 'stopped', stopReason: reason, updatedAt: new Date() })
    .where(and(eq(webScans.siteId, siteId), eq(webScans.status, 'queued')))
    .returning();
  return rows.length;
}

/** Reads one scan. */
export async function readScan(db: AppDb, scanId: string): Promise<WebScanScan | null> {
  const rows = await db.select().from(webScans).where(eq(webScans.id, scanId));
  const row = rows[0];
  return row === undefined ? null : toWebScanScan(row);
}

/** Lists the scans of a site, newest first. */
export async function listScans(db: AppDb, siteId: string): Promise<WebScanScan[]> {
  const rows = await db
    .select()
    .from(webScans)
    .where(eq(webScans.siteId, siteId))
    .orderBy(desc(webScans.createdAt));
  return rows.map(toWebScanScan);
}

/**
 * Queues a manual scan.
 *
 * The settings row is locked and re-read, and so is the site, so the pause switch and
 * the authorization are the ones that are current when the row is written. The
 * idempotency key makes a repeated request a replay instead of a second scan.
 */
export async function enqueueManualScan(
  db: AppDb,
  actor: string,
  input: EnqueueManualWebScanInput,
): Promise<EnqueueWebScanResult> {
  return db.transaction(async (tx) => {
    const settingsRow = await lockSettingsRow(tx);
    const settings = toWebScanSettings(settingsRow);
    if (settings.paused) {
      throw new WebScanPausedError();
    }

    const site = await lockSiteRow(tx, input.siteId);
    if (site === null) {
      throw new WebScanNotFoundError('The web scan site');
    }
    if (site.removedAt !== null) {
      throw new WebScanConflictError('A removed site cannot be scanned');
    }
    if (site.authorizationAuditId === null) {
      throw new WebScanAuthorizationError('The site is not authorized for scanning');
    }

    const effective: EffectiveScanSettings = {
      scope: input.scope ?? (site.overrides as ScanScope),
      limits: settings.limits,
      checks: input.checks ?? settings.checks,
      contact: settings.contact,
    };
    const fingerprint = requestFingerprint({
      siteId: input.siteId,
      scope: input.scope,
      checks: input.checks,
    });

    const existing = await tx
      .select()
      .from(webScans)
      .where(
        and(
          eq(webScans.siteId, input.siteId),
          eq(webScans.trigger, 'manual'),
          eq(webScans.idempotencyKey, input.idempotencyKey),
        ),
      );
    const previous = existing[0];
    if (previous !== undefined) {
      if (previous.requestFingerprint !== fingerprint) {
        throw new WebScanConflictError(
          'The idempotency key was already used for a different request',
        );
      }
      return { scan: toWebScanScan(previous), replayed: true };
    }

    const inserted = await tx
      .insert(webScans)
      .values({
        siteId: input.siteId,
        trigger: 'manual',
        status: 'queued',
        scheduledFor: null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        outboxState: 'pending',
        effectiveSettings: effective,
        authorizationAuditId: site.authorizationAuditId,
        scopeVersion: site.scopeVersion,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) {
      throw new Error('The web scan was not queued');
    }

    await appendAudit(tx, {
      actor,
      action: 'scan.enqueue',
      targetType: 'scan',
      targetId: row.id,
      after: { siteId: row.siteId, trigger: row.trigger, idempotencyKey: row.idempotencyKey },
    });

    return { scan: toWebScanScan(row), replayed: false };
  });
}

/**
 * The outcome of the shared scheduled enqueue.
 *
 * The two public wrappers report the same outcomes in their own way: the shared store
 * throws, the scheduler takes the null.
 */
export type ScheduledEnqueueOutcome =
  | { status: 'queued'; scan: WebScanScan }
  | { status: 'paused' }
  | { status: 'site_missing' }
  | { status: 'site_removed' }
  | { status: 'unauthorized' }
  | { status: 'schedule_disabled' }
  | { status: 'not_due'; nextRunAt: Date | null };

/** The input of the shared scheduled enqueue. */
export interface ScheduledEnqueueInput {
  siteId: string;
  /** The moment the schedule is evaluated. */
  now: Date;
  /**
   * The slot to queue.
   *
   * Without it the due slot of the site is used: the slot that is not in the future.
   * A site that has no slot yet only gets its first one.
   */
  slot?: Date | undefined;
}

/**
 * Queues the due occurrence of a site and advances its schedule.
 *
 * This is the one place that writes a scheduled scan. The scheduler of the worker and
 * the shared store both come here, so the pause switch, the authorization, the
 * idempotency of a slot and the advance of the schedule cannot drift apart.
 *
 * The settings row is locked and re-read, and so is the site, so the pause switch and
 * the authorization are the ones that are current when the row is written. The scan
 * and the advanced schedule are written in one transaction with the audit row, so a
 * schedule never runs twice for a slot and a queued scan always has its audit entry.
 *
 * The schedule catches up once: the slot that is due now is queued, and the schedule
 * then advances strictly beyond `now`. A scheduler that was down for a week does not
 * queue a week of scans, and it never queues the slot it just queued.
 */
export async function enqueueScheduledScanTx(
  tx: AppTx,
  actor: string,
  input: ScheduledEnqueueInput,
): Promise<ScheduledEnqueueOutcome> {
  // The lock order is settings, then site. See pg-lock-order.ts.
  const settingsRow = await lockSettingsRow(tx);
  const settings = toWebScanSettings(settingsRow);
  if (settings.paused) {
    return { status: 'paused' };
  }

  const site = await lockSiteRow(tx, input.siteId);
  if (site === null) {
    return { status: 'site_missing' };
  }
  if (site.removedAt !== null) {
    return { status: 'site_removed' };
  }
  if (site.authorizationAuditId === null) {
    return { status: 'unauthorized' };
  }

  const schedule = site.schedule;
  if (schedule === null || schedule.enabled !== true) {
    return { status: 'schedule_disabled' };
  }

  let slot = input.slot;
  if (slot === undefined) {
    const due = site.nextRunAt;
    if (due === null) {
      // The site has no slot yet. It gets its first one and nothing is queued.
      const nextRunAt = await advanceSchedule(tx, input.siteId, schedule, input.now);
      return { status: 'not_due', nextRunAt };
    }
    if (due.getTime() > input.now.getTime()) {
      return { status: 'not_due', nextRunAt: due };
    }
    slot = due;
  }

  const existing = await tx
    .select()
    .from(webScans)
    .where(
      and(
        eq(webScans.siteId, input.siteId),
        eq(webScans.trigger, 'scheduled'),
        eq(webScans.scheduledFor, slot),
      ),
    );
  const previous = existing[0];

  if (previous !== undefined) {
    // The slot was queued before. The scan is not queued twice, and the schedule still
    // advances, so the slot is not offered again.
    await advanceSchedule(tx, input.siteId, schedule, input.now);
    return { status: 'queued', scan: toWebScanScan(previous) };
  }

  const effective: EffectiveScanSettings = {
    scope: site.overrides as ScanScope,
    limits: settings.limits,
    checks: settings.checks,
    contact: settings.contact,
  };

  const inserted = await tx
    .insert(webScans)
    .values({
      siteId: input.siteId,
      trigger: 'scheduled',
      status: 'queued',
      scheduledFor: slot,
      idempotencyKey: null,
      requestFingerprint: null,
      outboxState: 'pending',
      effectiveSettings: effective,
      authorizationAuditId: site.authorizationAuditId,
      scopeVersion: site.scopeVersion,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    throw new Error('The scheduled web scan was not queued');
  }

  await advanceSchedule(tx, input.siteId, schedule, input.now);

  await appendAudit(tx, {
    actor,
    action: 'scan.enqueue',
    targetType: 'scan',
    targetId: row.id,
    after: { siteId: row.siteId, trigger: row.trigger, scheduledFor: row.scheduledFor },
  });

  return { status: 'queued', scan: toWebScanScan(row) };
}

/**
 * Advances the schedule of a site to its next occurrence, strictly beyond `now`.
 *
 * It runs inside the caller's transaction.
 */
async function advanceSchedule(
  tx: AppTx,
  siteId: string,
  schedule: WebScanSchedule,
  now: Date,
): Promise<Date> {
  const nextRunAt = nextScheduledRun(schedule, now);
  await tx
    .update(webScanSites)
    .set({ nextRunAt, updatedAt: now })
    .where(eq(webScanSites.id, siteId));
  return nextRunAt;
}

/**
 * Queues a scheduled scan.
 *
 * A thin wrapper over the shared scheduled enqueue, for the callers that ask for one
 * named slot. The scheduler of the worker asks for the due slot instead; both end up
 * in the same transaction body.
 */
export async function enqueueScheduledScan(
  db: AppDb,
  actor: string,
  input: EnqueueScheduledWebScanInput,
): Promise<WebScanScan> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const outcome = await enqueueScheduledScanTx(tx, actor, {
      siteId: input.siteId,
      now,
      slot: input.scheduledFor,
    });

    switch (outcome.status) {
      case 'queued':
        return outcome.scan;
      case 'paused':
        throw new WebScanPausedError();
      case 'site_missing':
        throw new WebScanNotFoundError('The web scan site');
      case 'site_removed':
        throw new WebScanConflictError('A removed site cannot be scanned');
      case 'unauthorized':
        throw new WebScanAuthorizationError('The site is not authorized for scanning');
      case 'schedule_disabled':
        throw new WebScanConflictError('The site has no enabled schedule');
      case 'not_due':
        throw new WebScanConflictError('The slot is not due');
    }
  });
}

/**
 * Cancels a queued or running scan by an administrator request (ADR-0052 section 6).
 *
 * One fenced conditional update does the whole stop: only a row that is still
 * `queued` or `running` is moved to `stopped`, and a row that is already
 * `completed`, `stopped` or `failed` is returned as it is. Two concurrent stops, or a
 * stop that races the completion of the worker, therefore cannot both win: the
 * second one changes nothing and writes nothing.
 *
 * The stop joins the worker's attempt fence this way. A queued scan is stopped
 * before it is ever claimed, so no request leaves the process. A running scan is
 * marked stopped and loses its attempt id, so the attempt no longer owns the row: the
 * worker's next live read reports `attemptOwned: false` and it stops before it sends
 * another request, and its later terminal write is refused by the attempt fence.
 *
 * The counters of a running scan are left alone: the request never overwrites what the
 * worker has already recorded. The stop state and its audit row are written in one
 * transaction, so a scan is never stopped without its audit entry.
 */
export async function stopScan(db: AppDb, actor: string, scanId: string): Promise<StopWebScanResult> {
  return db.transaction(async (tx) => {
    // The scan is read first, so the site row that is locked is the site of the scan
    // and not the site a caller claims. The lock order of the scanner is the same
    // here as it is in every other write: settings, site, scan, occurrence.
    const preview = await readScanRow(tx, scanId);
    if (preview === null) {
      throw new WebScanNotFoundError('The web scan');
    }
    if (preview.status === 'completed' || preview.status === 'stopped' || preview.status === 'failed') {
      return { scan: toWebScanScan(preview), outcome: 'already_terminal' };
    }

    await lockSiteRow(tx, preview.siteId);

    const now = new Date();
    const updated = await tx
      .update(webScans)
      .set({
        status: 'stopped',
        stopReason: 'cancelled',
        // The attempt no longer owns the row, so the row no longer names it.
        attemptId: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(webScans.id, scanId), inArray(webScans.status, ['queued', 'running'])))
      .returning();
    const row = updated[0];
    if (row === undefined) {
      // The row was terminal by the time of the update, so it is returned unchanged
      // and the write stays out. It cannot be missing: the preview above read it.
      const current = await tx.select().from(webScans).where(eq(webScans.id, scanId)).limit(1);
      const currentRow = current[0];
      if (currentRow === undefined) {
        throw new WebScanNotFoundError('The web scan');
      }
      return { scan: toWebScanScan(currentRow), outcome: 'already_terminal' };
    }

    await appendAudit(tx, {
      actor,
      action: 'scan.stop',
      targetType: 'scan',
      targetId: scanId,
      after: { status: 'stopped', stopReason: 'cancelled' },
    });

    return { scan: toWebScanScan(row), outcome: 'stopped' };
  });
}

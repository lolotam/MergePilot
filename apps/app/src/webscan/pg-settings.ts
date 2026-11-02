import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { WEB_SCAN_SETTINGS_ID, webScanSettings } from '../db/schema.js';
import { appendAudit } from './pg-audit.js';
import { parseSchedule } from './schedule.js';
import {
  WebScanConflictError,
  WebScanNotFoundError,
  WEB_SCAN_MAX_APPROVED_INSTALLATIONS,
  type WebScanSettingsPatch,
} from './store.js';
import type { WebScanApprovedInstallation, WebScanSettings } from './types.js';

/**
 * The global settings of the scanner (ADR-0052 section 5).
 *
 * Exactly one row exists. A change is written together with its audit row, so the
 * dashboard never shows a setting that was not audited.
 */

export type ScanSettingsRow = typeof webScanSettings.$inferSelect;

/** Maps a settings row onto the domain type. */
export function toWebScanSettings(row: ScanSettingsRow): WebScanSettings {
  return {
    paused: row.paused,
    alertsEnabled: row.alertsEnabled,
    limits: {
      maxRequests: row.maxRequests,
      maxPages: row.maxPages,
      maxActiveLinks: row.maxActiveLinks,
      requestsPerSecond: row.requestsPerSecond,
      requestTimeoutMs: row.requestTimeoutMs,
      maxResponseBytes: row.maxResponseBytes,
      totalTimeoutMs: row.totalTimeoutMs,
    },
    checks: row.checks,
    defaultSchedule: row.defaultSchedule,
    retentionDays: row.retentionDays,
    contact: row.contact,
    alertMinSeverity: row.alertMinSeverity as WebScanSettings['alertMinSeverity'],
    alertMinValidation: row.alertMinValidation as WebScanSettings['alertMinValidation'],
    approvedInstallations: row.approvedInstallations,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Reads the settings row. It is seeded by the migration and never removed. */
export async function readScanSettings(db: AppDb): Promise<WebScanSettings> {
  const rows = await db
    .select()
    .from(webScanSettings)
    .where(eq(webScanSettings.id, WEB_SCAN_SETTINGS_ID));
  const row = rows[0];
  if (row === undefined) {
    throw new Error('The web scan settings row is missing');
  }
  return toWebScanSettings(row);
}

/**
 * Writes a settings change and its audit row in one transaction.
 *
 * The row is locked first, so two concurrent changes are applied one after the other
 * and the audit log shows both in the order they were committed.
 *
 * A change that carries the moment of the snapshot it was computed from is refused
 * when the locked row moved since that snapshot: the change would merge into limits
 * that the confirmation never covered.
 */
export async function updateScanSettings(
  db: AppDb,
  actor: string,
  patch: WebScanSettingsPatch,
): Promise<WebScanSettings> {
  return db.transaction(async (tx) => {
    const before = await lockSettingsRow(tx);
    const current = toWebScanSettings(before);

    // The snapshot the change was computed from is checked against the locked row.
    // The row is locked now, so a change that was made in between is visible.
    if (
      patch.expectedUpdatedAt !== undefined &&
      before.updatedAt.getTime() !== patch.expectedUpdatedAt.getTime()
    ) {
      throw new WebScanConflictError('The settings changed while the request was prepared');
    }

    const limits = { ...current.limits, ...(patch.limits ?? {}) };
    // The default schedule is normalized before it is written, so a saved rule is
    // always evaluable and a biweekly rule keeps its anchor.
    const defaultSchedule =
      patch.defaultSchedule === undefined
        ? before.defaultSchedule
        : parseSchedule(patch.defaultSchedule, { savedAt: new Date() });

    const updated = await tx
      .update(webScanSettings)
      .set({
        paused: patch.paused ?? before.paused,
        alertsEnabled: patch.alertsEnabled ?? before.alertsEnabled,
        maxRequests: limits.maxRequests,
        maxPages: limits.maxPages,
        maxActiveLinks: limits.maxActiveLinks,
        requestsPerSecond: limits.requestsPerSecond,
        requestTimeoutMs: limits.requestTimeoutMs,
        maxResponseBytes: limits.maxResponseBytes,
        totalTimeoutMs: limits.totalTimeoutMs,
        retentionDays: patch.retentionDays ?? before.retentionDays,
        contact: patch.contact ?? before.contact,
        alertMinSeverity: patch.alertMinSeverity ?? before.alertMinSeverity,
        alertMinValidation: patch.alertMinValidation ?? before.alertMinValidation,
        checks: patch.checks ?? before.checks,
        defaultSchedule,
        // The approved-installation list has its own audited writes: only an
        // approval that GitHub proved may change it.
        approvedInstallations: before.approvedInstallations,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(eq(webScanSettings.id, WEB_SCAN_SETTINGS_ID))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan settings row was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'settings.update',
      targetType: 'settings',
      targetId: WEB_SCAN_SETTINGS_ID,
      before: current,
      after: toWebScanSettings(row),
    });

    return toWebScanSettings(row);
  });
}

/** Takes the row lock of the settings. Every enqueue locks it too. */
export async function lockSettingsRow(tx: AppTx): Promise<ScanSettingsRow> {
  const rows = await tx
    .select()
    .from(webScanSettings)
    .where(eq(webScanSettings.id, WEB_SCAN_SETTINGS_ID))
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw new Error('The web scan settings row is missing');
  }
  return row;
}

/**
 * Writes an approved installation and its audit row in one transaction.
 *
 * The row is locked first, so two approvals of the same moment are applied one
 * after the other. The entry of one administrator and installation is written
 * once: approving the same installation again replaces the old entry instead of
 * growing the list, and the list never grows past its bound.
 */
export async function approveScanInstallation(
  db: AppDb,
  actor: string,
  entry: WebScanApprovedInstallation,
): Promise<WebScanSettings> {
  return db.transaction(async (tx) => {
    const before = await lockSettingsRow(tx);
    const current = toWebScanSettings(before);
    const list = before.approvedInstallations;
    const known = list.some(
      (row) =>
        row.adminUserId === entry.adminUserId && row.installationId === entry.installationId,
    );
    if (!known && list.length >= WEB_SCAN_MAX_APPROVED_INSTALLATIONS) {
      throw new WebScanConflictError('The list of approved installations is full');
    }
    const next = known
      ? list.map((row) =>
          row.adminUserId === entry.adminUserId && row.installationId === entry.installationId
            ? entry
            : row,
        )
      : [...list, entry];

    const updated = await tx
      .update(webScanSettings)
      .set({ approvedInstallations: next, updatedAt: new Date(), updatedBy: actor })
      .where(eq(webScanSettings.id, WEB_SCAN_SETTINGS_ID))
      .returning();
    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan settings row was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'settings.approve_installation',
      targetType: 'settings',
      targetId: WEB_SCAN_SETTINGS_ID,
      before: current,
      after: toWebScanSettings(row),
    });

    return toWebScanSettings(row);
  });
}

/**
 * Removes an approved installation and writes its audit row in one transaction.
 *
 * An approval that is not there is a miss: the caller asked to remove something
 * the settings do not hold, and nothing is written.
 */
export async function revokeScanInstallationApproval(
  db: AppDb,
  actor: string,
  adminUserId: string,
  installationId: number,
): Promise<WebScanSettings> {
  return db.transaction(async (tx) => {
    const before = await lockSettingsRow(tx);
    const current = toWebScanSettings(before);
    const next = before.approvedInstallations.filter(
      (row) => !(row.adminUserId === adminUserId && row.installationId === installationId),
    );
    if (next.length === before.approvedInstallations.length) {
      throw new WebScanNotFoundError('The approved installation');
    }

    const updated = await tx
      .update(webScanSettings)
      .set({ approvedInstallations: next, updatedAt: new Date(), updatedBy: actor })
      .where(eq(webScanSettings.id, WEB_SCAN_SETTINGS_ID))
      .returning();
    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan settings row was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'settings.revoke_installation',
      targetType: 'settings',
      targetId: WEB_SCAN_SETTINGS_ID,
      before: current,
      after: toWebScanSettings(row),
    });

    return toWebScanSettings(row);
  });
}

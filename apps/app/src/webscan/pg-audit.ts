import { and, desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { webScanAudit } from '../db/schema.js';
import type { WebScanAuditEntry } from './types.js';

/**
 * The audit log of the scanner (ADR-0052 section 10).
 *
 * The log is append-only. This module can insert and read; there is no update and no
 * delete, and the database refuses both (see `0019_web_scan.sql`).
 */

/**
 * The actor of the maintenance the scanner runs on its own.
 *
 * The retention pass archives, prunes and restores the retained ledger. It is not a
 * person, and its audit rows say so instead of naming an administrator that never
 * touched them.
 */
export const WEB_SCAN_MAINTENANCE_ACTOR = 'scanner:maintenance';

/** The actor of the alert delivery writes. */
export const WEB_SCAN_ALERT_ACTOR = 'scanner:alerts';

/** One audited change. */
export interface AuditEntryInput {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * The keys whose value never reaches the audit log.
 *
 * The audit log stores the before and after of a change as JSON. A sealed value is
 * still a secret: its ciphertext must not be copied into the log, because the log is
 * shown in a dashboard and exported.
 */
const SECRET_KEYS = new Set([
  'ciphertext',
  'identitykey',
  'identitykeyciphertext',
  'plaintext',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'apikey',
  'apikeys',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'authorization',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Removes every secret from a value before it is written to the audit log.
 *
 * The walk is depth-first and it drops the whole value of a secret key, so a sealed
 * identity key never appears in the log, not even nested inside another object.
 */
export function sanitizeAuditValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (isSecretKey(key)) continue;
    result[key] = sanitizeAuditValue(item);
  }
  return result;
}

/**
 * Appends one audit row inside the caller's transaction.
 *
 * The caller is the only place that writes to the log, and it writes in the same
 * transaction as the change it describes. A failure of this insert therefore rolls
 * the change back.
 */
export async function appendAudit(tx: AppTx, entry: AuditEntryInput): Promise<string> {
  const rows = await tx
    .insert(webScanAudit)
    .values({
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: sanitizeAuditValue(entry.before),
      after: sanitizeAuditValue(entry.after),
    })
    .returning();
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('The web scan audit row was not written');
  }
  return id;
}

/** Reads the audit log, newest first. */
export async function listAudit(
  db: AppDb,
  options?: { limit?: number; targetType?: string; targetId?: string },
): Promise<WebScanAuditEntry[]> {
  const conditions = [];
  if (options?.targetType !== undefined) {
    conditions.push(eq(webScanAudit.targetType, options.targetType));
  }
  if (options?.targetId !== undefined) {
    conditions.push(eq(webScanAudit.targetId, options.targetId));
  }

  const rows = await db
    .select()
    .from(webScanAudit)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(webScanAudit.createdAt))
    .limit(options?.limit ?? 100);

  return rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    createdAt: row.createdAt,
  }));
}

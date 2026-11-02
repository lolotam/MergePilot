import { and, eq, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AppDb } from '../db/pg-store.js';
import { user as authUser } from '../auth/schema.js';
import { webScanAudit, webScanSettings, webScanSites, webScans } from '../db/schema.js';
import { appendAudit } from './pg-audit.js';
import { lockSiteRow, readScanRow, toWebScanScan } from './pg-rows.js';
import { enqueueScheduledScanTx } from './pg-scans.js';
import { writeScanOutcomeTx } from './pg-outcome.js';
import type { WebScanScan } from './types.js';
import {
  appendAuditSummary,
  failOrphanedAttempts,
  listOutboxScans,
  listStaleRunningScans,
  markOutboxPublished,
  markOutboxUnknown,
  pruneExpiredScans,
} from './worker-store-maintenance.js';
import type {
  WebScanAdministratorIdentity,
  WebScanClaimInput,
  WebScanHeartbeatInput,
  WebScanLiveAttempt,
  WebScanLiveState,
  WebScanOutboxEntry,
  WebScanOutcomeAttemptInput,
  WebScanPruneInput,
  WebScanTerminalWrite,
  WebScanWorkerStore,
} from './worker-store.js';

/**
 * The Postgres implementation of the worker persistence.
 *
 * The scan lifecycle lives here: the claim, the heartbeat, the attempt-fenced
 * terminal write, the live state a request needs and the scheduling of the due
 * occurrence of a site. The maintenance operations live in
 * `worker-store-maintenance.js`.
 */
export class PgWebScanWorkerStore implements WebScanWorkerStore {
  constructor(private readonly db: AppDb) {}

  async loadAdministratorIdentity(userId: string): Promise<WebScanAdministratorIdentity | null> {
    const rows = await this.db
      .select({ id: authUser.id, email: authUser.email, emailVerified: authUser.emailVerified })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { id: row.id, email: row.email, emailVerified: row.emailVerified };
  }

  async readLiveScanState(
    siteId: string,
    attempt?: WebScanLiveAttempt,
  ): Promise<WebScanLiveState | null> {
    const authorizer = alias(authUser, 'web_scan_original_authorizer');
    const rows = await this.db
      .select({
        paused: webScanSettings.paused,
        removedAt: webScanSites.removedAt,
        authorizedBy: webScanSites.authorizedBy,
        authorizationAuditId: webScanSites.authorizationAuditId,
        scopeVersion: webScanSites.scopeVersion,
        administratorId: authUser.id,
        administratorEmail: authUser.email,
        administratorEmailVerified: authUser.emailVerified,
        scanStatus: webScans.status,
        scanAttemptId: webScans.attemptId,
        authorizerId: authorizer.id,
        authorizerEmail: authorizer.email,
        authorizerEmailVerified: authorizer.emailVerified,
      })
      .from(webScanSites)
      .innerJoin(webScanSettings, sql`true`)
      .leftJoin(authUser, eq(authUser.id, webScanSites.authorizedBy))
      .leftJoin(
        webScans,
        attempt === undefined
          ? sql`false`
          : and(eq(webScans.id, attempt.scanId), eq(webScans.siteId, webScanSites.id)),
      )
      .leftJoin(
        webScanAudit,
        and(
          eq(
            webScanAudit.id,
            attempt === undefined ? webScanSites.authorizationAuditId : webScans.authorizationAuditId,
          ),
          eq(webScanAudit.action, 'site.authorize'),
          eq(webScanAudit.targetType, 'site'),
          or(
            eq(webScanAudit.targetId, sql<string>`${webScanSites.id}::text`),
            eq(webScanAudit.targetId, webScanSites.hostname),
          ),
        ),
      )
      .leftJoin(authorizer, eq(authorizer.id, sql<string>`${webScanAudit.after}->>'authorizedBy'`))
      .where(eq(webScanSites.id, siteId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const administrator =
      row.administratorId === null || row.administratorId === undefined
        ? null
        : {
            id: row.administratorId,
            email: row.administratorEmail ?? '',
            emailVerified: row.administratorEmailVerified === true,
          };
    return {
      paused: row.paused === true,
      administrator,
      removed: row.removedAt !== null,
      authorized: row.authorizedBy !== null && row.authorizationAuditId !== null,
      scopeVersion: row.scopeVersion,
      authorizingAdministrator: row.authorizerId === null
        ? null
        : {
            id: row.authorizerId,
            email: row.authorizerEmail ?? '',
            emailVerified: row.authorizerEmailVerified === true,
          },
      ...(attempt === undefined ? {} : {
        attemptOwned: row.scanStatus === 'running' && row.scanAttemptId === attempt.attemptId,
      }),
    };
  }

  async stopQueuedScan(input: {
    scanId: string;
    reason: string;
    now: Date;
  }): Promise<'stopped' | 'not_queued' | 'fenced'> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(webScans)
        .set({
          status: 'stopped',
          stopReason: input.reason,
          requests: 0,
          pages: 0,
          durationMs: 0,
          finishedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(webScans.id, input.scanId), eq(webScans.status, 'queued')))
        .returning();
      if (updated.length === 0) {
        const existing = await tx
          .select({ status: webScans.status })
          .from(webScans)
          .where(eq(webScans.id, input.scanId))
          .limit(1);
        const row = existing[0];
        if (row === undefined) return 'fenced';
        return row.status === 'queued' ? 'not_queued' : 'fenced';
      }
      await appendAudit(tx, {
        actor: 'worker',
        action: 'scan.stop',
        targetType: 'scan',
        targetId: input.scanId,
        after: { status: 'stopped', stopReason: input.reason },
      });
      return 'stopped';
    });
  }

  async claimScan(input: WebScanClaimInput): Promise<WebScanScan | null> {
    return this.db.transaction(async (tx) => {
      // The conditional update is the claim: only one worker can move a queued scan
      // to running, so a second delivery of the same job changes nothing.
      const updated = await tx
        .update(webScans)
        .set({
          status: 'running',
          attemptId: input.attemptId,
          heartbeatAt: input.now,
          startedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(webScans.id, input.scanId), eq(webScans.status, 'queued')))
        .returning();

      const row = updated[0];
      if (row === undefined) return null;

      await appendAudit(tx, {
        actor: `worker:${input.attemptId}`,
        action: 'scan.start',
        targetType: 'scan',
        targetId: row.id,
        after: { attemptId: input.attemptId, status: 'running', siteId: row.siteId },
      });

      return toWebScanScan(row);
    });
  }

  async heartbeatScan(input: WebScanHeartbeatInput): Promise<boolean> {
    const updated = await this.db
      .update(webScans)
      .set({ heartbeatAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(webScans.id, input.scanId),
          eq(webScans.attemptId, input.attemptId),
          eq(webScans.status, 'running'),
        ),
      )
      .returning();
    return updated.length > 0;
  }

  async recordScanOutcomeAttempt(
    actor: string,
    input: WebScanOutcomeAttemptInput,
  ): Promise<WebScanTerminalWrite> {
    return this.db.transaction(async (tx) => {
      // The site row is locked before the scan row, so the lock order of the scanner is
      // the same everywhere: settings, site, scan, occurrence.
      const preview = await readScanRow(tx, input.scanId);
      if (preview === null) return 'fenced';
      if (preview.siteId !== input.siteId) return 'fenced';

      await lockSiteRow(tx, preview.siteId);

      const rows = await tx
        .select()
        .from(webScans)
        .where(eq(webScans.id, input.scanId))
        .for('update');
      const scan = rows[0];
      if (scan === undefined) return 'fenced';
      if (scan.siteId !== input.siteId) return 'fenced';
      // The fence: an attempt that no longer owns the scan cannot write its outcome.
      if (scan.attemptId !== input.attemptId) return 'fenced';
      // A scan an administrator cancelled keeps the attempt id of the attempt that
      // ran it, so that attempt may still add the counters it made. Nothing else of
      // its outcome is written: the terminal state, the stop reason, the finished
      // moment, the findings, the coverage and the ledger stay as the administrator
      // left them, and no audit row is written.
      // The conditional update is the "first write wins" rule: the first write of the
      // counters clears the attempt id in the same update, so the attempt that owns
      // the scan cannot write the counters a second time. A later delivery of the
      // same outcome finds the row without its attempt id and is fenced, so it
      // changes nothing and reports nothing that was not written.
      if (scan.status === 'stopped' && scan.stopReason === 'cancelled') {
        await tx
          .update(webScans)
          .set({
            requests: input.requests,
            pages: input.pages,
            durationMs: input.durationMs,
            attemptId: null,
          })
          .where(
            and(
              eq(webScans.id, input.scanId),
              eq(webScans.attemptId, input.attemptId),
              eq(webScans.status, 'stopped'),
              eq(webScans.stopReason, 'cancelled'),
            ),
          );
        return 'already_terminal';
      }
      if (
        scan.status === 'completed' ||
        scan.status === 'stopped' ||
        scan.status === 'failed'
      ) {
        return 'already_terminal';
      }

      // The terminal write itself is the shared one: the state, the findings, the
      // coverage, the ledger transitions and the audit row are written exactly like the
      // shared store writes them. The attempt fence above decides whether it runs.
      await writeScanOutcomeTx(tx, actor, input, {
        now: input.now,
        attemptId: input.attemptId,
      });

      return 'recorded';
    });
  }

  async enqueueDueScheduledScan(
    actor: string,
    input: { siteId: string; now: Date },
  ): Promise<WebScanScan | null> {
    return this.db.transaction(async (tx) => {
      // The shared scheduled enqueue: the settings and the site are locked and re-read,
      // the due slot is queued once and the schedule advances strictly beyond now.
      const outcome = await enqueueScheduledScanTx(tx, actor, {
        siteId: input.siteId,
        now: input.now,
      });
      return outcome.status === 'queued' ? outcome.scan : null;
    });
  }

  listStaleRunningScans(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<WebScanOutboxEntry[]> {
    return listStaleRunningScans(this.db, input);
  }

  failOrphanedAttempts(input: {
    scanIds: readonly string[];
    staleBefore: Date;
    now: Date;
  }): Promise<number> {
    return failOrphanedAttempts(this.db, input);
  }

  listPendingOutboxScans(limit: number): Promise<WebScanOutboxEntry[]> {
    return listOutboxScans(this.db, limit, ['pending', 'unknown']);
  }

  listPublishedQueuedScans(limit: number): Promise<WebScanOutboxEntry[]> {
    return listOutboxScans(this.db, limit, ['published']);
  }

  markOutboxPublished(input: { scanId: string; now: Date }): Promise<boolean> {
    return markOutboxPublished(this.db, input);
  }

  markOutboxUnknown(input: { scanId: string; now: Date }): Promise<boolean> {
    return markOutboxUnknown(this.db, input);
  }

  pruneExpiredScans(input: WebScanPruneInput): Promise<number> {
    return pruneExpiredScans(this.db, input);
  }

  appendAuditSummary(input: {
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    after: unknown;
  }): Promise<void> {
    return appendAuditSummary(this.db, input);
  }
}

import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import type { AppTx } from '../db/workspace-lock.js';
import { webScanFindings, webScanSites, webScans } from '../db/schema.js';
import { appendAudit } from './pg-audit.js';
import { applyOccurrenceUpdates } from './pg-occurrences.js';
import { lockScanRow, lockSiteRow, readScanRow } from './pg-rows.js';
import {
  WebScanConflictError,
  WebScanNotFoundError,
  type RecordWebScanOutcomeInput,
} from './store.js';

/**
 * The terminal write of a scan (ADR-0052 section 6).
 *
 * This is the one place that writes the terminal state of a scan. The shared store and
 * the worker store both call it, so the two never drift apart: the state, the findings,
 * the coverage, the ledger transitions and the audit row are written the same way and
 * in one transaction, so a scan never ends with half of its result.
 *
 * The worker store adds its attempt fence around it. The fence decides whether the
 * write happens at all; the write itself is the same one.
 */

/**
 * Writes the terminal state of a scan inside the caller's transaction.
 *
 * The attempt id is the fence of the worker: when it is given, the row is only written
 * while the attempt still owns the scan.
 */
export async function writeScanOutcomeTx(
  tx: AppTx,
  actor: string,
  input: RecordWebScanOutcomeInput,
  options: { now: Date; attemptId?: string | undefined },
): Promise<void> {
  const now = options.now;
  const completed = input.status === 'completed';

  await tx
    .update(webScans)
    .set({
      status: input.status,
      stopReason: input.stopReason ?? null,
      failReason: input.failReason ?? null,
      requests: input.requests,
      pages: input.pages,
      durationMs: input.durationMs,
      coverageSummary: input.coverage,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      options.attemptId === undefined
        ? eq(webScans.id, input.scanId)
        : and(eq(webScans.id, input.scanId), eq(webScans.attemptId, options.attemptId)),
    );

  for (const finding of input.findings) {
    await tx.insert(webScanFindings).values({
      scanId: input.scanId,
      siteId: input.siteId,
      issueKey: finding.issueKey,
      occurrenceKey: finding.occurrenceKey,
      targetKey: finding.targetKey,
      checkId: finding.checkId,
      checkVersion: finding.checkVersion,
      issueId: finding.issueId,
      subject: finding.subject,
      severity: finding.severity,
      validation: finding.validation,
      confidence: finding.confidence,
      safeLocation: finding.safeLocation,
      evidence: finding.evidence,
      evidenceHash: finding.evidenceHash,
      comparison: finding.comparison,
    });
  }

  await applyOccurrenceUpdates(tx, input.siteId, input.scanId, input.updates, { now, completed });

  // The retained coverage of the site lives on the site row, so it survives the expiry
  // of the snapshot that produced it. Only a completed scan writes it: a stopped or
  // failed run is not a baseline and proves nothing about the coverage of a site.
  await tx
    .update(webScanSites)
    .set({
      lastScanAt: now,
      ...(completed
        ? {
            lastCoverageSummary: input.coverage,
            lastCoverageScanId: input.scanId,
            lastCoverageAt: now,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(webScanSites.id, input.siteId));

  await appendAudit(tx, {
    actor,
    action: completed ? 'scan.complete' : 'scan.finish',
    targetType: 'scan',
    targetId: input.scanId,
    after: {
      status: input.status,
      stopReason: input.stopReason ?? null,
      failReason: input.failReason ?? null,
      requests: input.requests,
      pages: input.pages,
      durationMs: input.durationMs,
      findings: input.findings.length,
    },
  });
}

/**
 * Writes the terminal state of a scan of the shared store.
 *
 * The site row is locked before the scan row, so the lock order of the scanner is the
 * same everywhere: settings, site, scan, occurrence.
 */
export async function recordScanOutcome(
  db: AppDb,
  actor: string,
  input: RecordWebScanOutcomeInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const preview = await readScanRow(tx, input.scanId);
    if (preview === null) {
      throw new WebScanNotFoundError('The web scan');
    }
    if (preview.siteId !== input.siteId) {
      throw new WebScanConflictError('The scan belongs to another site');
    }

    await lockSiteRow(tx, preview.siteId);

    const scan = await lockScanRow(tx, input.scanId);
    if (scan === null) {
      throw new WebScanNotFoundError('The web scan');
    }
    if (scan.siteId !== input.siteId) {
      throw new WebScanConflictError('The scan belongs to another site');
    }
    if (scan.status === 'completed' || scan.status === 'stopped' || scan.status === 'failed') {
      throw new WebScanConflictError('The scan already has a terminal state');
    }

    await writeScanOutcomeTx(tx, actor, input, { now: new Date() });
  });
}

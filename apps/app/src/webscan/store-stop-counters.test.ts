import { describe, expect, it } from 'vitest';
import { fixture, occurrenceFinding, registeredSite, unpause } from './store.fixtures.js';
import { PgWebScanWorkerStore } from './worker-store-persistence.js';

/**
 * The counters of a scan an administrator cancelled (ADR-0052 section 6).
 *
 * A running scan keeps its attempt id when the administrator stops it, so the
 * attempt that made the requests may still record how many it made. It may change
 * nothing else: the terminal state, the results and the audit stay as the
 * administrator left them, and only the first write of the counters counts.
 */

const ISSUE_KEY = 'headers|headers/strict-transport-security|example.com';

describe('the counters of a cancelled scan', () => {
  it('records the counters of the cancelled attempt and changes nothing else', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-counters',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'attempt-counters' };
      await worker.claimScan({ ...attempt, now: new Date() });

      const stopped = await store.stopScan('admin-1', queued.scan.id);
      expect(stopped.outcome).toBe('stopped');
      const finishedAt = stopped.scan.finishedAt;
      expect(finishedAt).not.toBeNull();

      const write = await worker.recordScanOutcomeAttempt('worker:attempt-counters', {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'stopped',
        stopReason: 'attempt_lost',
        requests: 7,
        pages: 3,
        durationMs: 1200,
        findings: [
          {
            id: 'finding-1',
            scanId: queued.scan.id,
            siteId: site.id,
            issueKey: ISSUE_KEY,
            occurrenceKey: 'occ-1',
            targetKey: 'target-1',
            checkId: 'headers',
            checkVersion: 1,
            issueId: 'headers/strict-transport-security',
            subject: 'Strict-Transport-Security',
            severity: 'medium',
            validation: 'Likely',
            confidence: 'high',
            safeLocation: 'https://example.com/',
            evidence: { header: 'missing' },
            evidenceHash: 'hash-1',
            comparison: 'New',
          },
        ],
        coverage: [
          {
            targetKey: 'target-1',
            checkId: 'headers',
            checkVersion: 1,
            evaluatedIssueIds: [ISSUE_KEY],
            outcome: 'checked',
          },
        ],
        updates: [
          {
            state: 'outstanding',
            finding: occurrenceFinding({
              occurrenceKey: 'occ-1',
              issueKey: ISSUE_KEY,
              evidenceHash: 'hash-1',
              comparison: 'New',
              evidence: { header: 'missing' },
            }),
          },
        ],
      });
      expect(write).toBe('already_terminal');

      const after = await store.getScan(queued.scan.id);
      expect(after?.status).toBe('stopped');
      expect(after?.stopReason).toBe('cancelled');
      expect(after?.requests).toBe(7);
      expect(after?.pages).toBe(3);
      expect(after?.durationMs).toBe(1200);
      expect(after?.finishedAt).toEqual(finishedAt);
      expect(after?.coverageSummary).toBeNull();

      // No finding, no ledger transition and no retained coverage of the cancelled
      // attempt reached the site.
      const findings = await db.client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM web_scan_findings WHERE scan_id = $1',
        [queued.scan.id],
      );
      expect(findings.rows[0]?.count).toBe(0);
      expect(await store.listOccurrences(site.id)).toEqual([]);
      const siteAfter = await store.getSite(site.id);
      expect(siteAfter?.lastCoverage).toBeNull();
      expect(siteAfter?.lastCoverageScanId).toBeNull();
      expect(siteAfter?.lastScanAt).toBeNull();

      // The write of the counters wrote no audit row of its own.
      const audits = await store.listAudit({ targetType: 'scan', targetId: queued.scan.id });
      expect(audits.filter((row) => row.action === 'scan.stop')).toHaveLength(1);
      expect(audits.some((row) => row.action === 'scan.finish')).toBe(false);
      expect(audits.some((row) => row.action === 'scan.complete')).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('lets only the first write of the counters count', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-counters-twice',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'attempt-twice' };
      await worker.claimScan({ ...attempt, now: new Date() });
      await store.stopScan('admin-1', queued.scan.id);

      const outcome = {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'stopped',
        stopReason: 'attempt_lost',
        findings: [],
        coverage: [],
        updates: [],
      };
      expect(
        await worker.recordScanOutcomeAttempt('worker:attempt-twice', {
          ...outcome,
          requests: 7,
          pages: 3,
          durationMs: 1200,
        }),
      ).toBe('already_terminal');

      // The second write of the same attempt changes nothing.
      expect(
        await worker.recordScanOutcomeAttempt('worker:attempt-twice', {
          ...outcome,
          requests: 99,
          pages: 42,
          durationMs: 9999,
        }),
      ).toBe('already_terminal');

      const after = await store.getScan(queued.scan.id);
      expect(after?.requests).toBe(7);
      expect(after?.pages).toBe(3);
      expect(after?.durationMs).toBe(1200);
    } finally {
      await db.close();
    }
  });

  it('fences an attempt that never owned the cancelled scan', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-counters-foreign',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      await worker.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-owner',
        now: new Date(),
      });
      await store.stopScan('admin-1', queued.scan.id);

      const write = await worker.recordScanOutcomeAttempt('worker:attempt-foreign', {
        scanId: queued.scan.id,
        siteId: site.id,
        attemptId: 'attempt-foreign',
        now: new Date(),
        status: 'completed',
        requests: 7,
        pages: 3,
        durationMs: 1200,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(write).toBe('fenced');

      const after = await store.getScan(queued.scan.id);
      expect(after?.status).toBe('stopped');
      expect(after?.requests).toBe(0);
      expect(after?.pages).toBe(0);
      expect(after?.durationMs).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('leaves a completed scan untouched when a late write arrives', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-counters-completed',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'attempt-completed' };
      await worker.claimScan({ ...attempt, now: new Date() });

      const completed = await worker.recordScanOutcomeAttempt('worker:attempt-completed', {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'completed',
        requests: 4,
        pages: 2,
        durationMs: 80,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(completed).toBe('recorded');

      const late = await worker.recordScanOutcomeAttempt('worker:attempt-completed', {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'stopped',
        stopReason: 'cancelled',
        requests: 7,
        pages: 3,
        durationMs: 1200,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(late).toBe('already_terminal');

      const after = await store.getScan(queued.scan.id);
      expect(after?.status).toBe('completed');
      expect(after?.requests).toBe(4);
      expect(after?.pages).toBe(2);
      expect(after?.durationMs).toBe(80);
    } finally {
      await db.close();
    }
  });
});

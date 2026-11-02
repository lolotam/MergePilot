import { describe, expect, it } from 'vitest';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { WebScanNotFoundError } from './store.js';
import { PgWebScanWorkerStore } from './worker-store-persistence.js';

/**
 * The administrator stop of a scan (ADR-0052 section 6).
 *
 * The stop runs in the web process while the scan runs in the worker process, so it
 * works through the row the worker reads before every request: the stop takes the
 * row away from the attempt, the attempt loses the ownership of the scan and its
 * later terminal write is refused by the attempt fence.
 */

const UNKNOWN_SCAN_ID = '11111111-1111-4111-8111-111111111111';

describe('the administrator stop of a scan', () => {
  it('stops a queued scan without a single request and audits it once', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-queued',
      });

      const stopped = await store.stopScan('admin-1', queued.scan.id);
      expect(stopped.outcome).toBe('stopped');
      expect(stopped.scan.status).toBe('stopped');
      expect(stopped.scan.stopReason).toBe('cancelled');
      expect(stopped.scan.requests).toBe(0);
      expect(stopped.scan.finishedAt).not.toBeNull();
      // A scan that was never claimed has no attempt, so the stop cannot name one.
      expect(stopped.scan.attemptId).toBeNull();

      const audits = await store.listAudit({ targetType: 'scan', targetId: queued.scan.id });
      expect(audits.filter((row) => row.action === 'scan.stop')).toHaveLength(1);
      expect(audits.find((row) => row.action === 'scan.stop')?.actor).toBe('admin-1');

      // A stopped scan is never claimed, so no request can leave the process.
      const worker = new PgWebScanWorkerStore(db.db);
      expect(await worker.claimScan({ scanId: queued.scan.id, attemptId: 'a', now: new Date() })).toBeNull();

      // An attempt that never owned the scan cannot write anything into it.
      const write = await worker.recordScanOutcomeAttempt('worker:a', {
        scanId: queued.scan.id,
        siteId: site.id,
        attemptId: 'a',
        now: new Date(),
        status: 'completed',
        requests: 4,
        pages: 2,
        durationMs: 60,
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

  it('stops a running scan and takes the row away from its attempt', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-running',
      });
      const worker = new PgWebScanWorkerStore(db.db);
      const attempt = { scanId: queued.scan.id, attemptId: 'attempt-stop' };
      await worker.claimScan({ ...attempt, now: new Date() });

      const stopped = await store.stopScan('admin-1', queued.scan.id);
      expect(stopped.outcome).toBe('stopped');
      expect(stopped.scan.status).toBe('stopped');
      expect(stopped.scan.stopReason).toBe('cancelled');
      // The row keeps the attempt id, so the attempt may still record its counters.
      expect(stopped.scan.attemptId).toBe('attempt-stop');

      // The attempt no longer owns the row, so the worker stops before it sends
      // another request.
      const live = await worker.readLiveScanState(site.id, attempt);
      expect(live?.attemptOwned).toBe(false);

      // The terminal write of the attempt finds the scan terminal. It records the
      // counters the attempt made and leaves the rest of the outcome alone.
      const write = await worker.recordScanOutcomeAttempt('worker:attempt-stop', {
        ...attempt,
        siteId: site.id,
        now: new Date(),
        status: 'completed',
        requests: 7,
        pages: 2,
        durationMs: 50,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(write).toBe('already_terminal');
      const after = await store.getScan(queued.scan.id);
      expect(after?.status).toBe('stopped');
      expect(after?.stopReason).toBe('cancelled');
      expect(after?.requests).toBe(7);
      expect(after?.pages).toBe(2);
      expect(after?.durationMs).toBe(50);
    } finally {
      await db.close();
    }
  });

  it('leaves a scan that already finished alone and writes no audit row', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-terminal',
      });
      await store.recordScanOutcome('worker', {
        scanId: queued.scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 20,
        findings: [],
        coverage: [],
        updates: [],
      });

      const stopped = await store.stopScan('admin-1', queued.scan.id);
      expect(stopped.outcome).toBe('already_terminal');
      expect(stopped.scan.status).toBe('completed');
      expect(stopped.scan.requests).toBe(3);
      expect(stopped.scan.stopReason).toBeNull();

      const audits = await store.listAudit({ targetType: 'scan', targetId: queued.scan.id });
      expect(audits.filter((row) => row.action === 'scan.stop')).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('stops a scan only once, even when the stop is repeated', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'stop-twice',
      });

      const first = await store.stopScan('admin-1', queued.scan.id);
      const second = await store.stopScan('admin-1', queued.scan.id);
      expect(first.outcome).toBe('stopped');
      expect(second.outcome).toBe('already_terminal');
      expect(second.scan.id).toBe(first.scan.id);

      const audits = await store.listAudit({ targetType: 'scan', targetId: queued.scan.id });
      expect(audits.filter((row) => row.action === 'scan.stop')).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('refuses a scan that does not exist', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      await registeredSite(store);
      await expect(store.stopScan('admin-1', UNKNOWN_SCAN_ID)).rejects.toBeInstanceOf(
        WebScanNotFoundError,
      );
    } finally {
      await db.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { fixture, registeredSite, unpause } from './store.fixtures.js';
import { PgWebScanWorkerStore } from './worker-store-persistence.js';

/**
 * The worker persistence (ADR-0052 section 7).
 *
 * These tests run against a real database, because the invariants they prove are
 * transactional: the claim is atomic, the terminal write is fenced by the attempt id
 * and the pruning keeps the baseline of every site.
 */

const NOW = new Date('2026-01-02T02:00:00.000Z');

describe('the claim of a queued scan', () => {
  it('moves the scan to running exactly once', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);

      const claimed = await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      expect(claimed?.status).toBe('running');
      expect(claimed?.attemptId).toBe('attempt-1');

      // A second delivery of the same job changes nothing.
      const second = await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-2',
        now: NOW,
      });
      expect(second).toBeNull();

      const scan = await store.getScan(queued.scan.id);
      expect(scan?.attemptId).toBe('attempt-1');
    } finally {
      await db.close();
    }
  });

  it('writes the audit row of the claim', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-2',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);

      await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      const audit = await store.listAudit({ targetType: 'scan' });
      expect(audit.some((row) => row.action === 'scan.start')).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('the heartbeat of a running scan', () => {
  it('refreshes the heartbeat of the attempt that owns the scan', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-3',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);
      await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      const later = new Date(NOW.getTime() + 30_000);
      expect(
        await workerStore.heartbeatScan({
          scanId: queued.scan.id,
          attemptId: 'attempt-1',
          now: later,
        }),
      ).toBe(true);

      // Another attempt cannot refresh the heartbeat of a scan it does not own.
      expect(
        await workerStore.heartbeatScan({
          scanId: queued.scan.id,
          attemptId: 'attempt-2',
          now: later,
        }),
      ).toBe(false);
    } finally {
      await db.close();
    }
  });
});

describe('the terminal write of a scan', () => {
  it('is fenced by the attempt id', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-4',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);
      await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      const outcome = {
        scanId: queued.scan.id,
        siteId: site.id,
        status: 'completed' as const,
        requests: 2,
        pages: 1,
        durationMs: 50,
        findings: [],
        coverage: [],
        updates: [],
      };

      // An attempt that does not own the scan cannot write its outcome.
      expect(
        await workerStore.recordScanOutcomeAttempt('worker:attempt-2', {
          ...outcome,
          attemptId: 'attempt-2',
          now: NOW,
        }),
      ).toBe('fenced');

      expect(
        await workerStore.recordScanOutcomeAttempt('worker:attempt-1', {
          ...outcome,
          attemptId: 'attempt-1',
          now: NOW,
        }),
      ).toBe('recorded');

      // A second write of the same attempt finds a terminal scan.
      expect(
        await workerStore.recordScanOutcomeAttempt('worker:attempt-1', {
          ...outcome,
          attemptId: 'attempt-1',
          now: NOW,
        }),
      ).toBe('already_terminal');
    } finally {
      await db.close();
    }
  });

  it('never lets an old worker overwrite the reconciliation', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-5',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);
      await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      // The reconciliation marks the orphaned attempt failed.
      const failed = await workerStore.failOrphanedAttempts({
        scanIds: [queued.scan.id],
        staleBefore: new Date(NOW.getTime() + 60_000),
        now: NOW,
      });
      expect(failed).toBe(1);

      // The old worker comes back and tries to write its outcome.
      const write = await workerStore.recordScanOutcomeAttempt('worker:attempt-1', {
        scanId: queued.scan.id,
        siteId: site.id,
        attemptId: 'attempt-1',
        now: NOW,
        status: 'completed',
        requests: 2,
        pages: 1,
        durationMs: 50,
        findings: [],
        coverage: [],
        updates: [],
      });
      expect(write).toBe('already_terminal');

      const scan = await store.getScan(queued.scan.id);
      expect(scan?.status).toBe('failed');
      expect(scan?.failReason).toBe('worker_lost');
    } finally {
      await db.close();
    }
  });
});

describe('the outbox of the scanner', () => {
  it('lists the unpublished intents and marks them published', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-6',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);

      const pending = await workerStore.listPendingOutboxScans(10);
      expect(pending.map((entry) => entry.scanId)).toContain(queued.scan.id);

      expect(
        await workerStore.markOutboxPublished({ scanId: queued.scan.id, now: NOW }),
      ).toBe(true);
      expect(
        await workerStore.listPendingOutboxScans(10).then((entries) =>
          entries.map((entry) => entry.scanId),
        ),
      ).not.toContain(queued.scan.id);
    } finally {
      await db.close();
    }
  });

  it('marks an uncertain publication unknown so it is retried under the same job id', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-7',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);

      expect(
        await workerStore.markOutboxUnknown({ scanId: queued.scan.id, now: NOW }),
      ).toBe(true);

      const pending = await workerStore.listPendingOutboxScans(10);
      expect(pending.map((entry) => entry.scanId)).toContain(queued.scan.id);
    } finally {
      await db.close();
    }
  });
});

describe('the reconciliation of the orphaned attempts', () => {
  it('lists only the running attempts whose heartbeat is stale', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const queued = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-8',
      });
      const workerStore = new PgWebScanWorkerStore(db.db);
      await workerStore.claimScan({
        scanId: queued.scan.id,
        attemptId: 'attempt-1',
        now: NOW,
      });

      const stale = await workerStore.listStaleRunningScans({
        staleBefore: new Date(NOW.getTime() + 60_000),
        limit: 10,
      });
      expect(stale.map((entry) => entry.scanId)).toContain(queued.scan.id);

      // A heartbeat that is fresh is not stale.
      const fresh = await workerStore.listStaleRunningScans({
        staleBefore: new Date(NOW.getTime() - 60_000),
        limit: 10,
      });
      expect(fresh.map((entry) => entry.scanId)).not.toContain(queued.scan.id);
    } finally {
      await db.close();
    }
  });
});

describe('the pruning of the expired snapshots', () => {
  it('keeps the last completed scan of a site as the baseline', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const workerStore = new PgWebScanWorkerStore(db.db);

      const first = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-9',
      });
      const second = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-10',
      });

      // The two scans reach a terminal state; the newer one is the baseline.
      await db.client.query(
        `UPDATE web_scans SET status = 'completed', created_at = $2 WHERE id = $1`,
        [first.scan.id, new Date('2026-01-01T00:00:00.000Z')],
      );
      await db.client.query(
        `UPDATE web_scans SET status = 'completed', created_at = $2 WHERE id = $1`,
        [second.scan.id, new Date('2026-01-02T00:00:00.000Z')],
      );

      const pruned = await workerStore.pruneExpiredScans({
        olderThan: new Date('2026-01-03T00:00:00.000Z'),
        limit: 10,
      });

      expect(pruned).toBe(1);
      const scans = await store.listScans(site.id);
      expect(scans.map((scan) => scan.id)).toEqual([second.scan.id]);
    } finally {
      await db.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { TestDbHandle } from '../db/test-db.js';
import {
  backdateLedger,
  fixture,
  occurrenceFinding,
  registeredSite,
  unpause,
} from './store.fixtures.js';

/**
 * The audit log of the maintenance and of the alerts (ADR-0052 section 10).
 *
 * A state change and the record of that change belong together: either both are
 * written or neither is. A tombstone that is archived, pruned or restored without a
 * record of why would leave the ledger unauditable, and the same is true of a delivery
 * state of an alert.
 */

const ISSUE_KEY = 'headers|headers/strict-transport-security|example.com';

/** Observes one occurrence as outstanding, so the ledger of the site holds it. */
async function observeOutstanding(
  store: Awaited<ReturnType<typeof fixture>>['store'],
  siteId: string,
  idempotencyKey: string,
  occurrenceKey: string,
  evidenceHash: string,
): Promise<void> {
  const { scan } = await store.enqueueManualScan('admin-1', { siteId, idempotencyKey });
  await store.recordScanOutcome('worker', {
    scanId: scan.id,
    siteId,
    status: 'completed',
    requests: 3,
    pages: 1,
    durationMs: 120,
    findings: [],
    coverage: [],
    updates: [
      {
        state: 'outstanding',
        finding: occurrenceFinding({
          occurrenceKey,
          issueKey: ISSUE_KEY,
          evidenceHash,
          comparison: 'New',
          evidence: { header: 'missing' },
        }),
      },
    ],
  });
}

describe('the audit log of the maintenance', () => {
  it('records the archival of the retained ledger', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');
      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);

      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);

      const audit = await store.listAudit({ targetType: 'site', targetId: site.id });
      const archived = audit.filter((entry) => entry.action === 'occurrence.archive');
      expect(archived).toHaveLength(1);
      expect(archived[0]?.actor).toBe('scanner:maintenance');
      expect(archived[0]?.after).toEqual({ archived: 1 });
    } finally {
      await db.close();
    }
  });

  it('records the pruning of the tombstones a completed scan proved fixed', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');
      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      await store.archiveUnprovenOccurrences(site.id);

      // A completed scan proves the identity fixed, so the tombstone becomes prunable.
      const { scan } = await store.enqueueManualScan('admin-1', { siteId: site.id, idempotencyKey: 'key-2' });
      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage: [],
        updates: [
          {
            state: 'fixed',
            finding: occurrenceFinding({
              occurrenceKey: 'occ-1',
              issueKey: ISSUE_KEY,
              evidenceHash: 'hash-1',
              comparison: 'Fixed',
              evidence: { header: 'present' },
            }),
          },
        ],
      });

      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(1);

      const audit = await store.listAudit({ targetType: 'site', targetId: site.id });
      const pruned = audit.filter((entry) => entry.action === 'occurrence.prune');
      expect(pruned).toHaveLength(1);
      expect(pruned[0]?.after).toEqual({ pruned: 1 });
    } finally {
      await db.close();
    }
  });

  it('records the restoration of the tombstones of an expired resolution', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      // A live resolution pins the tombstone it covers.
      const exception = await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);

      // The resolution ends.
      await db.client.query(
        'UPDATE web_scan_exceptions SET expires_at = $1 WHERE id = $2',
        [new Date(Date.now() - 1000), exception.id],
      );

      expect(await store.restoreExpiredExceptionOccurrences(site.id)).toBe(1);

      const audit = await store.listAudit({ targetType: 'site', targetId: site.id });
      const restored = audit.filter((entry) => entry.action === 'occurrence.restore');
      expect(restored).toHaveLength(1);
      expect(restored[0]?.after).toMatchObject({ restored: 1 });
    } finally {
      await db.close();
    }
  });

  it('never writes the scope, the evidence or a free-form reason into the log', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');
      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      await store.archiveUnprovenOccurrences(site.id);
      await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
      });
      await store.upsertAlert({
        siteId: site.id,
        issueKey: 'issue-1',
        episodeKey: 'episode-1',
        repositoryId: 1,
        installationId: 2,
        githubAccountId: 3,
        deliveryMarker: 'marker-1',
        deliveryState: 'pending',
        issueState: 'unknown',
        occurrenceKeys: ['occ-1'],
      });

      // The maintenance rows and the alert row carry counts and states, never the
      // scope, the evidence, the occurrence keys or the free-form reason.
      const maintenance = (await store.listAudit({})).filter(
        (entry) =>
          entry.action === 'occurrence.archive' ||
          entry.action === 'occurrence.prune' ||
          entry.action === 'occurrence.restore' ||
          entry.action === 'alert.upsert',
      );
      expect(maintenance.length).toBeGreaterThan(0);
      const text = JSON.stringify(maintenance);
      expect(text).not.toContain('The header is set by the edge proxy.');
      expect(text).not.toContain('crawlPaths');
      expect(text).not.toContain('occ-1');
      expect(text).not.toContain('missing');
    } finally {
      await db.close();
    }
  });
});

describe('the pages of the audit log', () => {
  /** The moment every row of the test shares, so the id is the only tiebreaker. */
  const MOMENT = new Date('2026-01-01T00:00:00.000Z');

  /** The ids of the rows; the id orders them from the newest to the oldest. */
  const IDS = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
  ];

  /** Writes one audit row with a fixed id and the given moment. */
  async function writeRow(
    db: TestDbHandle,
    id: string,
    createdAt: Date = MOMENT,
  ): Promise<void> {
    await db.client.query(
      'INSERT INTO web_scan_audit (id, actor, action, target_type, target_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, 'admin-1', 'site.create', 'site', 'site-1', createdAt],
    );
  }

  it('reads the pages of rows that share a moment without a gap or a duplicate', async () => {
    const { db, store } = await fixture();
    try {
      for (const id of IDS) await writeRow(db, id);

      const first = await store.listAudit({ limit: 2, offset: 0 });
      const second = await store.listAudit({ limit: 2, offset: 2 });
      const third = await store.listAudit({ limit: 2, offset: 4 });

      // The rows share their moment, so the id decides the order of every page.
      expect(first.map((row) => row.id)).toEqual([IDS[4], IDS[3]]);
      expect(second.map((row) => row.id)).toEqual([IDS[2], IDS[1]]);
      expect(third.map((row) => row.id)).toEqual([IDS[0]]);

      // The pages together hold every row of the log exactly once.
      const walked = [...first, ...second, ...third].map((row) => row.id);
      expect(walked).toHaveLength(IDS.length);
      expect(new Set(walked).size).toBe(IDS.length);
    } finally {
      await db.close();
    }
  });

  it('reads the rows of an offset and counts the log', async () => {
    const { db, store } = await fixture();
    try {
      for (const id of IDS) await writeRow(db, id);

      // The rows before the offset are skipped by the database, not read and dropped.
      const deep = await store.listAudit({ limit: 2, offset: 3 });
      expect(deep.map((row) => row.id)).toEqual([IDS[1], IDS[0]]);

      // An offset past the end of the log is an empty page, and the log still
      // holds every row it held before.
      const beyond = await store.listAudit({ limit: 10, offset: 50 });
      expect(beyond).toEqual([]);
      expect(await store.countAudit()).toBe(IDS.length);

      // The count knows the rows of one target apart from the whole log.
      expect(await store.countAudit({ targetType: 'site' })).toBe(IDS.length);
      expect(await store.countAudit({ targetType: 'exception' })).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('reads the page and its total from one call', async () => {
    const { db, store } = await fixture();
    try {
      for (const id of IDS) await writeRow(db, id);

      const page = await store.listAuditPage({ limit: 2, offset: 0 });

      // The page holds the newest rows, in the order of the log.
      expect(page.entries.map((row) => row.id)).toEqual([IDS[4], IDS[3]]);
      // The total is the number of rows of the whole log.
      expect(page.total).toBe(IDS.length);
    } finally {
      await db.close();
    }
  });

  it('never lets a page hold more rows than the log has', async () => {
    const { db, store } = await fixture();
    try {
      for (const id of IDS) await writeRow(db, id);

      // A small first page of a log that holds more rows than it reads.
      const page = await store.listAuditPage({ limit: 2, offset: 0 });
      expect(page.entries.length).toBe(2);
      expect(page.entries.length).toBeLessThanOrEqual(page.total);
    } finally {
      await db.close();
    }
  });

  it('reports the total of the log for a page that is past its end', async () => {
    const { db, store } = await fixture();
    try {
      for (const id of IDS) await writeRow(db, id);

      // An empty page is still a page of the log, so it still knows its total.
      const beyond = await store.listAuditPage({ limit: 10, offset: 50 });
      expect(beyond.entries).toEqual([]);
      expect(beyond.total).toBe(IDS.length);
    } finally {
      await db.close();
    }
  });

  it('orders the rows by their moment', async () => {
    const { db, store } = await fixture();
    try {
      await writeRow(db, IDS[0], new Date('2026-01-01T00:00:00.000Z'));
      await writeRow(db, IDS[1], new Date('2026-01-02T00:00:00.000Z'));
      await writeRow(db, IDS[2], new Date('2026-01-03T00:00:00.000Z'));

      const audit = await store.listAudit({ limit: 3 });
      expect(audit.map((row) => row.id)).toEqual([IDS[2], IDS[1], IDS[0]]);
    } finally {
      await db.close();
    }
  });
});

describe('the audit log of the alerts', () => {
  it('records the delivery state of an alert', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const alert = await store.upsertAlert({
        siteId: site.id,
        issueKey: 'issue-1',
        episodeKey: 'episode-1',
        repositoryId: 1,
        installationId: 2,
        githubAccountId: 3,
        deliveryMarker: 'marker-1',
        deliveryState: 'pending',
        issueState: 'unknown',
        occurrenceKeys: ['occ-1'],
      });

      const audit = await store.listAudit({ targetType: 'alert', targetId: alert.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('alert.upsert');
      expect(audit[0]?.after).toMatchObject({ deliveryState: 'pending', issueState: 'unknown' });
      // The occurrence keys of the alert are not written into the log.
      expect(JSON.stringify(audit)).not.toContain('occ-1');
    } finally {
      await db.close();
    }
  });

  it('rolls the delivery state back when its audit row cannot be written', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await db.client.query('ALTER TABLE web_scan_audit RENAME TO web_scan_audit_hidden');

      await expect(
        store.upsertAlert({
          siteId: site.id,
          issueKey: 'issue-1',
          episodeKey: 'episode-1',
          repositoryId: 1,
          installationId: 2,
          githubAccountId: 3,
          deliveryMarker: 'marker-1',
          deliveryState: 'pending',
          issueState: 'unknown',
          occurrenceKeys: [],
        }),
      ).rejects.toThrow();

      // The delivery state was not written either: the mutation and its audit row
      // share one transaction.
      await db.client.query('ALTER TABLE web_scan_audit_hidden RENAME TO web_scan_audit');
      expect(await store.listAlerts(site.id)).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

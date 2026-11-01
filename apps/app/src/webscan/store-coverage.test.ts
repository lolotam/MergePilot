import type { CoverageEntry } from '@mergepilot/webscan';
import { describe, expect, it } from 'vitest';
import {
  backdateLedger,
  fixture,
  occurrenceFinding,
  registeredSite,
  unpause,
} from './store.fixtures.js';

/**
 * The retained state that outlives a scan snapshot (ADR-0052 section 11).
 *
 * The current coverage of a site is not a property of a scan snapshot: the snapshot
 * expires, the coverage of the site does not.
 */

describe('the retained coverage of a site', () => {
  it('keeps the coverage of the last completed scan on the site row', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const coverage: CoverageEntry[] = [
        {
          targetKey: 'target-1',
          checkId: 'headers',
          checkVersion: 1,
          evaluatedIssueIds: ['headers/strict-transport-security'],
          outcome: 'checked',
        },
      ];

      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage,
        updates: [],
      });

      // The coverage lives on the site, not on the snapshot.
      const afterScan = await store.getSite(site.id);
      expect(afterScan?.lastCoverage).toEqual(coverage);
      expect(afterScan?.lastCoverageScanId).toBe(scan.id);
      expect(afterScan?.lastCoverageAt).not.toBeNull();

      // The snapshot expires, and the coverage of the site survives it.
      await db.client.query(`DELETE FROM web_scans WHERE id = $1`, [scan.id]);
      const afterExpiry = await store.getSite(site.id);
      expect(afterExpiry?.lastCoverage).toEqual(coverage);
      expect(afterExpiry?.lastCoverageScanId).toBe(scan.id);
    } finally {
      await db.close();
    }
  });

  it('keeps the coverage of the last completed scan when a stopped run ends later', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const completed = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const coverage: CoverageEntry[] = [
        {
          targetKey: 'target-1',
          checkId: 'headers',
          checkVersion: 1,
          evaluatedIssueIds: [],
          outcome: 'checked',
        },
      ];
      await store.recordScanOutcome('worker', {
        scanId: completed.scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage,
        updates: [],
      });

      // A stopped run is not a baseline, so it does not become the retained coverage.
      const stopped = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-2',
      });
      await store.recordScanOutcome('worker', {
        scanId: stopped.scan.id,
        siteId: site.id,
        status: 'stopped',
        stopReason: 'budget_exhausted',
        requests: 1,
        pages: 0,
        durationMs: 10,
        findings: [],
        coverage: [
          {
            targetKey: 'target-2',
            checkId: 'headers',
            checkVersion: 1,
            evaluatedIssueIds: [],
            outcome: 'not-visited',
          },
        ],
        updates: [],
      });

      const siteAfter = await store.getSite(site.id);
      expect(siteAfter?.lastCoverage).toEqual(coverage);
      expect(siteAfter?.lastCoverageScanId).toBe(completed.scan.id);
    } finally {
      await db.close();
    }
  });

  it('counts the retained coverage as an evaluation after the snapshot expired', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const { scan } = await store.enqueueManualScan('admin-1', {
        siteId: site.id,
        idempotencyKey: 'key-1',
      });
      const coverage: CoverageEntry[] = [
        {
          targetKey: 'target-1',
          checkId: 'headers',
          checkVersion: 1,
          evaluatedIssueIds: ['headers/strict-transport-security'],
          outcome: 'checked',
        },
      ];
      await store.recordScanOutcome('worker', {
        scanId: scan.id,
        siteId: site.id,
        status: 'completed',
        requests: 3,
        pages: 1,
        durationMs: 120,
        findings: [],
        coverage,
        updates: [
          {
            state: 'outstanding',
            finding: occurrenceFinding({
              occurrenceKey: 'occ-1',
              issueKey: 'headers|headers/strict-transport-security|example.com',
              evidenceHash: 'hash-1',
              comparison: 'New',
              evidence: { header: 'missing' },
            }),
          },
        ],
      });

      // The horizon elapsed and the snapshot of the evaluating scan is gone. The
      // retained coverage still knows that the identity was evaluated, so the
      // occurrence is not an unobserved one.
      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      await db.client.query(`DELETE FROM web_scans WHERE id = $1`, [scan.id]);

      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(0);
      expect((await store.listOccurrences(site.id))[0]?.state).toBe('outstanding');
    } finally {
      await db.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  backdateLedger,
  fixture,
  occurrenceFinding,
  registeredSite,
  unpause,
} from './store.fixtures.js';

/**
 * The administrator resolutions of the scanner (ADR-0052 section 9).
 *
 * A resolution applies only while the occurrence key and the evidence hash still match
 * and only while it is neither revoked nor expired. It never authorizes pruning.
 */

const ISSUE_KEY = 'headers|headers/strict-transport-security|example.com';

/** Records a completed scan that observed one occurrence as outstanding. */
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

describe('the administrator resolutions', () => {
  it('applies a resolution only to the occurrence key and the evidence hash it was recorded against', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      const exception = await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
      });
      expect((await store.listOccurrences(site.id))[0]?.exceptionId).toBe(exception.id);

      // The evidence of the identity changed, so the resolution covers nothing now.
      await observeOutstanding(store, site.id, 'key-2', 'occ-1', 'hash-2');
      expect((await store.listOccurrences(site.id))[0]?.exceptionId).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('stops applying a resolution once it expired', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      // A resolution that is recorded with an expiry in the past applies to nothing.
      await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect((await store.listOccurrences(site.id))[0]?.exceptionId).toBeNull();
      expect(await store.listLiveExceptions(site.id, new Date())).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('restores a tombstone under the same identity when the resolution ends', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);
      const tombstone = (await store.listOccurrences(site.id))[0];
      expect(tombstone?.state).toBe('archived');
      expect(tombstone?.evidence).toBeNull();

      const exception = await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
      });
      expect((await store.listOccurrences(site.id))[0]?.exceptionId).toBe(exception.id);

      // The resolution ends, so the blocker comes back under the same identity.
      await store.revokeException('admin-1', exception.id);
      const restored = (await store.listOccurrences(site.id))[0];
      expect(restored?.state).toBe('outstanding');
      expect(restored?.occurrenceKey).toBe('occ-1');
      expect(restored?.targetKey).toBe('target-1');
      expect(restored?.issueKey).toBe(ISSUE_KEY);
      expect(restored?.evidence).toBeNull();
      expect(restored?.exceptionId).toBeNull();
      // Every other safe field comes from the retained metadata, nothing is invented.
      expect(restored?.severity).toBe('medium');
      expect(restored?.validation).toBe('Likely');
      expect(restored?.confidence).toBe('high');
      expect(restored?.safeLocation).toBe('https://example.com/');
    } finally {
      await db.close();
    }
  });
});

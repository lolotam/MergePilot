import { describe, expect, it } from 'vitest';
import {
  backdateLedger,
  fixture,
  occurrenceFinding,
  registeredSite,
  unpause,
} from './store.fixtures.js';

/**
 * What proves an occurrence fixed, and when a tombstone may go (ADR-0052 section 11).
 *
 * Only a completed scan is a baseline, so only a completed scan may prove an identity
 * fixed and make a tombstone prunable.
 */

const ISSUE_KEY = 'headers|headers/strict-transport-security|example.com';

/** Records a scan that observed one occurrence as outstanding. */
async function observeOutstanding(
  store: Awaited<ReturnType<typeof fixture>>['store'],
  siteId: string,
  idempotencyKey: string,
  occurrenceKey: string,
  evidenceHash: string,
): Promise<string> {
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
  return scan.id;
}

/** Records a scan that claims one occurrence is fixed. */
async function claimFixed(
  store: Awaited<ReturnType<typeof fixture>>['store'],
  siteId: string,
  idempotencyKey: string,
  occurrenceKey: string,
  evidenceHash: string,
  status: 'completed' | 'stopped',
): Promise<void> {
  const { scan } = await store.enqueueManualScan('admin-1', { siteId, idempotencyKey });
  await store.recordScanOutcome('worker', {
    scanId: scan.id,
    siteId,
    status,
    ...(status === 'stopped' ? { stopReason: 'budget_exhausted' } : {}),
    requests: 3,
    pages: 1,
    durationMs: 120,
    findings: [],
    coverage: [],
    updates: [
      {
        state: 'fixed',
        finding: occurrenceFinding({
          occurrenceKey,
          issueKey: ISSUE_KEY,
          evidenceHash,
          comparison: 'Not checked',
          evidence: null,
        }),
      },
    ],
  });
}

describe('proving an occurrence fixed', () => {
  it('lets only a completed scan prove an identity fixed', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      const completed = await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      // A stopped run claims the identity is fixed. It is not a baseline, so the claim
      // is refused and the identity keeps the state the completed scan gave it.
      await claimFixed(store, site.id, 'key-2', 'occ-1', 'hash-1', 'stopped');

      const occurrences = await store.listOccurrences(site.id);
      expect(occurrences[0]?.state).toBe('outstanding');
      expect(occurrences[0]?.lastCompletedScanId).toBe(completed);
    } finally {
      await db.close();
    }
  });

  it('never prunes a tombstone a run that did not complete claimed to be fixed', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      // The horizon elapses and nobody evaluated the identity, so it becomes a
      // tombstone.
      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);
      expect((await store.listOccurrences(site.id))[0]?.state).toBe('archived');

      // A stopped run cannot prove the tombstone fixed, so it stays a tombstone and
      // nothing is pruned.
      await claimFixed(store, site.id, 'key-2', 'occ-1', 'hash-1', 'stopped');

      expect((await store.listOccurrences(site.id))[0]?.state).toBe('archived');
      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(0);
      expect(await store.listOccurrences(site.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});

describe('pruning the tombstones', () => {
  it('never prunes a tombstone an administrator resolution still holds', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');

      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(1);

      // A resolution without an expiry still holds the tombstone.
      const exception = await store.createException('admin-1', {
        siteId: site.id,
        occurrenceKey: 'occ-1',
        evidenceHash: 'hash-1',
        kind: 'accepted',
        reasonCategory: 'accepted_risk',
        reason: 'The header is set by the edge proxy.',
      });

      // A completed scan proves the identity fixed, and the tombstone stays.
      await claimFixed(store, site.id, 'key-2', 'occ-1', 'hash-1', 'completed');

      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(0);
      const held = (await store.listOccurrences(site.id))[0];
      expect(held?.occurrenceKey).toBe('occ-1');
      expect(held?.targetKey).toBe('target-1');
      expect(held?.issueKey).toBe(ISSUE_KEY);
      expect(held?.exceptionId).toBe(exception.id);

      // The resolution ends, so the tombstone may go.
      await store.revokeException('admin-1', exception.id);
      expect((await store.listOccurrences(site.id))[0]?.exceptionId).toBeNull();
      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(1);
      expect(await store.listOccurrences(site.id)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('never prunes a tombstone while its group still holds an unresolved blocker', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await observeOutstanding(store, site.id, 'key-1', 'occ-1', 'hash-1');
      await observeOutstanding(store, site.id, 'key-2', 'occ-2', 'hash-2');

      await store.updateSettings('admin-1', { retentionDays: 1 });
      await backdateLedger(db, site.id);
      expect(await store.archiveUnprovenOccurrences(site.id)).toBe(2);

      // One member of the group is proven fixed, the other one is not.
      await claimFixed(store, site.id, 'key-3', 'occ-1', 'hash-1', 'completed');

      // The group still holds an unresolved blocker, so nothing is pruned.
      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(0);
      expect(await store.listOccurrences(site.id)).toHaveLength(2);

      // The blocker is resolved, and the group may go.
      await claimFixed(store, site.id, 'key-4', 'occ-2', 'hash-2', 'completed');

      expect(await store.pruneProvenFixedTombstones(site.id)).toBe(2);
      expect(await store.listOccurrences(site.id)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

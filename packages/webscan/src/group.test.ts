import { describe, expect, it } from 'vitest';

import {
  MAX_EVIDENCE_SAMPLES,
  activeOccurrences,
  exceptionApplies,
  groupOccurrences,
} from './group.js';
import type { OccurrenceRecord, ScanException } from './types.js';

const NOW = 1_700_000_000_000;

/** One occurrence record. */
function record(overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return {
    occurrenceKey: 'occurrence-1',
    targetKey: 'target-1',
    issueKey: 'headers|missing-strict-transport-security|example.com',
    checkId: 'headers',
    issueId: 'missing-strict-transport-security',
    subject: 'strict-transport-security',
    severity: 'medium',
    validation: 'Confirmed',
    confidence: 'high',
    safeLocation: 'https://example.com/',
    evidenceHash: 'v1:hash-1',
    evidence: { header: 'strict-transport-security' },
    state: 'outstanding',
    comparison: 'Unchanged',
    ...overrides,
  };
}

/** One administrator resolution. */
function exception(overrides: Partial<ScanException> = {}): ScanException {
  return {
    occurrenceKey: 'occurrence-1',
    evidenceHash: 'v1:hash-1',
    kind: 'accepted',
    expiresAt: NOW + 86_400_000,
    ...overrides,
  };
}

describe('the issue groups of a site', () => {
  it('groups the occurrences of one issue and keeps the groups apart', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', targetKey: 'target-1' }),
        record({ occurrenceKey: 'occurrence-2', targetKey: 'target-2' }),
        record({
          occurrenceKey: 'occurrence-3',
          issueKey: 'headers|missing-content-security-policy|example.com',
          issueId: 'missing-content-security-policy',
          subject: 'content-security-policy',
        }),
      ],
      { now: NOW },
    );

    expect(groups).toHaveLength(2);
    // The groups are ordered by their issue key, never by the order of the input.
    expect(groups[0]?.issueKey).toBe('headers|missing-content-security-policy|example.com');
    expect(groups[0]?.occurrences).toHaveLength(1);
    expect(groups[1]?.issueKey).toBe('headers|missing-strict-transport-security|example.com');
    expect(groups[1]?.occurrences).toHaveLength(2);
  });

  it('keeps the identity of every occurrence', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', subject: 'session', evidenceHash: 'v1:hash-1' }),
        record({ occurrenceKey: 'occurrence-2', subject: 'tracker', evidenceHash: 'v1:hash-2' }),
      ],
      { now: NOW },
    );

    const group = groups[0];
    expect(group?.occurrences.map((occurrence) => occurrence.occurrenceKey)).toEqual([
      'occurrence-1',
      'occurrence-2',
    ]);
    expect(group?.occurrences.map((occurrence) => occurrence.subject)).toEqual(['session', 'tracker']);
    expect(group?.occurrences.map((occurrence) => occurrence.evidenceHash)).toEqual([
      'v1:hash-1',
      'v1:hash-2',
    ]);
    expect(group?.occurrences.map((occurrence) => occurrence.state)).toEqual([
      'outstanding',
      'outstanding',
    ]);
    expect(group?.occurrences.map((occurrence) => occurrence.comparison)).toEqual([
      'Unchanged',
      'Unchanged',
    ]);
  });

  it('orders the groups and the members deterministically', () => {
    const first = record({ occurrenceKey: 'occurrence-b' });
    const second = record({ occurrenceKey: 'occurrence-a' });
    const forward = groupOccurrences([first, second], { now: NOW });
    const backward = groupOccurrences([second, first], { now: NOW });
    expect(forward).toEqual(backward);
    expect(forward[0]?.occurrences.map((occurrence) => occurrence.occurrenceKey)).toEqual([
      'occurrence-a',
      'occurrence-b',
    ]);
  });

  it('counts the affected targets by their distinct target key', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', targetKey: 'target-1', subject: 'session' }),
        record({ occurrenceKey: 'occurrence-2', targetKey: 'target-1', subject: 'tracker' }),
        record({ occurrenceKey: 'occurrence-3', targetKey: 'target-2', subject: 'session' }),
      ],
      { now: NOW },
    );

    // Two cookies of one URL do not enlarge the surface.
    expect(groups[0]?.affectedTargets).toBe(2);
  });

  it('does not enlarge the surface when the safe locations collapse', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', targetKey: 'target-1' }),
        record({
          occurrenceKey: 'occurrence-2',
          targetKey: 'target-2',
          safeLocation: 'https://example.com/{segment}',
        }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.affectedTargets).toBe(2);
    expect(groups[0]?.occurrences.map((occurrence) => occurrence.safeLocation)).toEqual([
      'https://example.com/',
      'https://example.com/{segment}',
    ]);
  });
});

describe('the evidence samples of a group', () => {
  it('keeps at most five samples', () => {
    const records = Array.from({ length: 9 }, (_, index) =>
      record({
        occurrenceKey: `occurrence-${index}`,
        targetKey: `target-${index}`,
        safeLocation: `https://example.com/${index}`,
      }),
    );

    const groups = groupOccurrences(records, { now: NOW });

    expect(MAX_EVIDENCE_SAMPLES).toBe(5);
    expect(groups[0]?.evidenceSamples).toHaveLength(5);
  });

  it('orders the samples independently of the order of the input', () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      record({
        occurrenceKey: `occurrence-${index}`,
        targetKey: `target-${index}`,
        safeLocation: `https://example.com/${index}`,
      }),
    );

    const forward = groupOccurrences(records, { now: NOW });
    const backward = groupOccurrences([...records].reverse(), { now: NOW });

    expect(forward[0]?.evidenceSamples).toEqual(backward[0]?.evidenceSamples);
    expect(forward[0]?.evidenceSamples.map((sample) => sample.safeLocation)).toEqual([
      'https://example.com/0',
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ]);
  });

  it('carries the safe evidence of the occurrence', () => {
    const groups = groupOccurrences([record({ evidence: { header: 'strict-transport-security' } })], {
      now: NOW,
    });
    expect(groups[0]?.evidenceSamples[0]).toMatchObject({
      occurrenceKey: 'occurrence-1',
      safeLocation: 'https://example.com/',
      evidenceHash: 'v1:hash-1',
      evidence: { header: 'strict-transport-security' },
    });
  });
});

describe('the fixed state of a group', () => {
  it('is reached when every member was proven fixed', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', state: 'fixed', comparison: 'Fixed' }),
        record({ occurrenceKey: 'occurrence-2', targetKey: 'target-2', state: 'fixed', comparison: 'Fixed' }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.status).toBe('fixed');
    expect(groups[0]?.fixed).toBe(true);
    expect(groups[0]?.fixedCount).toBe(2);
  });

  it('is not reached while one member was not checked', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', state: 'fixed', comparison: 'Fixed' }),
        record({ occurrenceKey: 'occurrence-2', targetKey: 'target-2', comparison: 'Not checked' }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.status).toBe('open');
    expect(groups[0]?.fixed).toBe(false);
    expect(groups[0]?.blockers).toEqual(['occurrence-2']);
  });

  it('is not reached while an archived member was never proven fixed', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1', state: 'fixed', comparison: 'Fixed' }),
        record({
          occurrenceKey: 'occurrence-2',
          targetKey: 'target-2',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.status).toBe('blocked');
    expect(groups[0]?.fixed).toBe(false);
    expect(groups[0]?.archivedUnverifiedCount).toBe(1);
    expect(groups[0]?.blockers).toEqual(['occurrence-2']);
  });

  it('keeps the old blocker when a new target appears', () => {
    const groups = groupOccurrences(
      [
        record({
          occurrenceKey: 'occurrence-old',
          targetKey: 'target-old',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
        record({ occurrenceKey: 'occurrence-new', targetKey: 'target-new' }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.status).toBe('blocked');
    expect(groups[0]?.outstandingCount).toBe(1);
    expect(groups[0]?.archivedUnverifiedCount).toBe(1);
    expect(groups[0]?.blockers).toEqual(['occurrence-new', 'occurrence-old']);
  });

  it('does not let a churned variant close the group', () => {
    const groups = groupOccurrences(
      [
        record({
          occurrenceKey: 'occurrence-old',
          targetKey: 'target-old',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
        record({
          occurrenceKey: 'occurrence-new',
          targetKey: 'target-new',
          state: 'fixed',
          comparison: 'Fixed',
        }),
      ],
      { now: NOW },
    );

    expect(groups[0]?.status).toBe('blocked');
    expect(groups[0]?.fixed).toBe(false);
  });
});

describe('an administrator resolution', () => {
  it('applies to the exact occurrence key and evidence hash', () => {
    expect(exceptionApplies(exception(), record(), NOW)).toBe(true);
    expect(exceptionApplies(exception({ occurrenceKey: 'other' }), record(), NOW)).toBe(false);
    expect(exceptionApplies(exception({ evidenceHash: 'v1:other' }), record(), NOW)).toBe(false);
  });

  it('does not apply after it expired', () => {
    expect(exceptionApplies(exception({ expiresAt: NOW }), record(), NOW)).toBe(false);
    expect(exceptionApplies(exception({ expiresAt: NOW - 1 }), record(), NOW)).toBe(false);
    expect(exceptionApplies(exception({ expiresAt: NOW + 1 }), record(), NOW)).toBe(true);
  });

  it('applies without an expiry', () => {
    expect(exceptionApplies(exception({ expiresAt: null }), record(), NOW)).toBe(true);
  });

  it('labels the finding without hiding or fixing it', () => {
    const groups = groupOccurrences([record()], { exceptions: [exception()], now: NOW });

    expect(groups[0]?.occurrences[0]?.exception).toBe('accepted');
    expect(groups[0]?.exceptedCount).toBe(1);
    expect(groups[0]?.status).toBe('resolved_by_exception');
    expect(groups[0]?.fixed).toBe(false);
    expect(groups[0]?.occurrences).toHaveLength(1);
  });

  it('does not apply when the evidence changed', () => {
    const groups = groupOccurrences([record({ evidenceHash: 'v1:changed' })], {
      exceptions: [exception()],
      now: NOW,
    });

    expect(groups[0]?.occurrences[0]?.exception).toBeUndefined();
    expect(groups[0]?.exceptedCount).toBe(0);
    expect(groups[0]?.status).toBe('open');
  });

  it('does not apply when it expired', () => {
    const groups = groupOccurrences([record()], {
      exceptions: [exception({ expiresAt: NOW - 1 })],
      now: NOW,
    });

    expect(groups[0]?.occurrences[0]?.exception).toBeUndefined();
    expect(groups[0]?.status).toBe('open');
  });

  it('unblocks an archived member as resolved by exception', () => {
    const groups = groupOccurrences(
      [
        record({
          occurrenceKey: 'occurrence-1',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
      ],
      { exceptions: [exception()], now: NOW },
    );

    expect(groups[0]?.status).toBe('resolved_by_exception');
    expect(groups[0]?.archivedUnverifiedCount).toBe(0);
    expect(groups[0]?.fixed).toBe(false);
  });

  it('is fixed when every member was proven fixed, whatever a stale resolution says', () => {
    const groups = groupOccurrences(
      [record({ occurrenceKey: 'occurrence-1', state: 'fixed', comparison: 'Fixed' })],
      { exceptions: [exception()], now: NOW },
    );

    expect(groups[0]?.status).toBe('fixed');
    expect(groups[0]?.fixed).toBe(true);
    expect(groups[0]?.exceptedCount).toBe(0);
  });

  it('keeps the blocker when the exception covers another occurrence', () => {    const groups = groupOccurrences(
      [
        record({
          occurrenceKey: 'occurrence-1',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
      ],
      { exceptions: [exception({ occurrenceKey: 'occurrence-other' })], now: NOW },
    );

    expect(groups[0]?.status).toBe('blocked');
    expect(groups[0]?.archivedUnverifiedCount).toBe(1);
  });
});

describe('the active members of a group', () => {
  it('are the outstanding members without a resolution', () => {
    const groups = groupOccurrences(
      [
        record({ occurrenceKey: 'occurrence-1' }),
        record({ occurrenceKey: 'occurrence-2', targetKey: 'target-2' }),
        record({ occurrenceKey: 'occurrence-3', targetKey: 'target-3', state: 'fixed', comparison: 'Fixed' }),
        record({
          occurrenceKey: 'occurrence-4',
          targetKey: 'target-4',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
      ],
      { exceptions: [exception({ occurrenceKey: 'occurrence-2' })], now: NOW },
    );

    expect(activeOccurrences(groups[0]!).map((occurrence) => occurrence.occurrenceKey)).toEqual([
      'occurrence-1',
    ]);
  });
});

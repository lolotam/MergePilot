import { describe, expect, it } from 'vitest';

import { groupOccurrences } from './group.js';
import {
  CONFIDENCE_FACTORS,
  SEVERITY_BASE_FACTORS,
  VALIDATION_FACTORS,
  assessGroupRisk,
  assessOccurrenceRisk,
  surfaceFactor,
} from './risk.js';
import type { OccurrenceRecord } from './types.js';

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
    severity: 'high',
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

/** The group of the given records. */
function group(records: readonly OccurrenceRecord[]) {
  return groupOccurrences(records, { now: NOW })[0]!;
}

describe('the risk factors of ADR-0052 section 4', () => {
  it('are the documented severity bases', () => {
    expect(SEVERITY_BASE_FACTORS).toEqual({
      critical: 10,
      high: 8,
      medium: 5,
      low: 2.5,
      info: 1,
    });
  });

  it('are the documented confidence factors', () => {
    expect(CONFIDENCE_FACTORS).toEqual({ high: 1, medium: 0.8, low: 0.6 });
  });

  it('are the documented validation factors', () => {
    expect(VALIDATION_FACTORS).toEqual({
      Confirmed: 1,
      Likely: 0.85,
      Indicator: 0.6,
      Informational: 0.4,
    });
  });

  it('grow the surface with the number of affected targets', () => {
    expect(surfaceFactor(1)).toBe(1);
    expect(surfaceFactor(2)).toBeCloseTo(1.1, 10);
    expect(surfaceFactor(6)).toBeCloseTo(1.5, 10);
    expect(surfaceFactor(7)).toBeCloseTo(1.5, 10);
    expect(surfaceFactor(60)).toBeCloseTo(1.5, 10);
  });
});

describe('the risk of a group', () => {
  it('is the exact formula for one affected target', () => {
    const assessment = assessGroupRisk(group([record()]));

    expect(assessment.score).toBeCloseTo(8, 10);
    expect(assessment.factors).toEqual({
      severityBase: 8,
      confidence: 1,
      validation: 1,
      surface: 1,
      affectedUrls: 1,
    });
    expect(assessment.source?.occurrenceKey).toBe('occurrence-1');
  });

  it('grows with the number of affected targets', () => {
    const records = Array.from({ length: 6 }, (_, index) =>
      record({ occurrenceKey: `occurrence-${index}`, targetKey: `target-${index}` }),
    );

    const assessment = assessGroupRisk(group(records));

    expect(assessment.factors.affectedUrls).toBe(6);
    expect(assessment.factors.surface).toBeCloseTo(1.5, 10);
    // 8 * 1 * 1 * 1.5 = 12, capped at ten.
    expect(assessment.score).toBe(10);
  });

  it('does not enlarge the surface when two cookies share one target', () => {
    const assessment = assessGroupRisk(
      group([
        record({ occurrenceKey: 'occurrence-1', subject: 'session' }),
        record({ occurrenceKey: 'occurrence-2', subject: 'tracker' }),
      ]),
    );

    expect(assessment.factors.affectedUrls).toBe(1);
    expect(assessment.factors.surface).toBe(1);
    expect(assessment.score).toBeCloseTo(8, 10);
  });

  it('is capped at ten', () => {
    const records = Array.from({ length: 6 }, (_, index) =>
      record({
        occurrenceKey: `occurrence-${index}`,
        targetKey: `target-${index}`,
        severity: 'critical',
      }),
    );

    const assessment = assessGroupRisk(group(records));

    expect(assessment.score).toBe(10);
  });

  it('is zero for a group without an active member', () => {
    const assessment = assessGroupRisk(
      group([record({ state: 'fixed', comparison: 'Fixed' })]),
    );

    expect(assessment.score).toBe(0);
    expect(assessment.source).toBeNull();
    expect(assessment.factors.affectedUrls).toBe(0);
  });

  it('ignores an archived member', () => {
    const assessment = assessGroupRisk(
      group([
        record({ occurrenceKey: 'occurrence-1' }),
        record({
          occurrenceKey: 'occurrence-2',
          targetKey: 'target-2',
          severity: 'critical',
          state: 'archived',
          comparison: 'Not checked',
          archiveReason: 'unobserved_retention',
          evidence: null,
        }),
      ]),
    );

    expect(assessment.factors.affectedUrls).toBe(1);
    expect(assessment.score).toBeCloseTo(8, 10);
    expect(assessment.source?.occurrenceKey).toBe('occurrence-1');
  });

  it('ignores an excepted member', () => {
    const assessment = assessGroupRisk(
      groupOccurrences(
        [
          record({ occurrenceKey: 'occurrence-1' }),
          record({
            occurrenceKey: 'occurrence-2',
            targetKey: 'target-2',
            severity: 'critical',
            evidenceHash: 'v1:hash-2',
          }),
        ],
        {
          now: NOW,
          exceptions: [
            { occurrenceKey: 'occurrence-2', evidenceHash: 'v1:hash-2', kind: 'accepted', expiresAt: null },
          ],
        },
      )[0]!,
    );

    expect(assessment.factors.affectedUrls).toBe(1);
    expect(assessment.score).toBeCloseTo(8, 10);
  });

  it('takes the factors of one observation instead of combining the strongest ones', () => {
    const assessment = assessGroupRisk(
      group([
        record({
          occurrenceKey: 'occurrence-a',
          severity: 'high',
          confidence: 'low',
          validation: 'Confirmed',
        }),
        record({
          occurrenceKey: 'occurrence-b',
          targetKey: 'target-2',
          severity: 'medium',
          confidence: 'high',
          validation: 'Likely',
        }),
      ]),
    );

    // The weighted observation of the first one is 8 * 0.6 * 1 = 4.8, the second
    // one is 5 * 1 * 0.85 = 4.25. The first one wins with its own factors.
    expect(assessment.source?.occurrenceKey).toBe('occurrence-a');
    expect(assessment.factors.severityBase).toBe(8);
    expect(assessment.factors.confidence).toBe(0.6);
    expect(assessment.factors.validation).toBe(1);
    // The two members cover two targets, so the surface is 1.1.
    expect(assessment.factors.surface).toBeCloseTo(1.1, 10);
    expect(assessment.score).toBeCloseTo(4.8 * 1.1, 10);
  });

  it('breaks a tie deterministically', () => {
    const assessment = assessGroupRisk(
      group([
        record({ occurrenceKey: 'occurrence-b', targetKey: 'target-2' }),
        record({ occurrenceKey: 'occurrence-a' }),
      ]),
    );

    expect(assessment.source?.occurrenceKey).toBe('occurrence-a');
  });

  it('does not round the score', () => {
    const assessment = assessGroupRisk(
      group([
        record({ severity: 'high', confidence: 'medium', validation: 'Likely' }),
        record({
          occurrenceKey: 'occurrence-2',
          targetKey: 'target-2',
          severity: 'high',
          confidence: 'medium',
          validation: 'Likely',
        }),
      ]),
    );

    // 8 * 0.8 * 0.85 * 1.1 is the score. It is never rounded to 5.98.
    expect(assessment.score).toBe(8 * 0.8 * 0.85 * 1.1);
    expect(assessment.score).not.toBe(5.98);
  });
});

describe('the risk of one occurrence', () => {
  it('uses the factors of that occurrence and the surface of its group', () => {
    const assessment = assessOccurrenceRisk(
      {
        occurrenceKey: 'occurrence-1',
        targetKey: 'target-1',
        issueKey: 'headers|missing-strict-transport-security|example.com',
        checkId: 'headers',
        issueId: 'missing-strict-transport-security',
        subject: 'strict-transport-security',
        severity: 'medium',
        validation: 'Likely',
        confidence: 'medium',
        safeLocation: 'https://example.com/',
        evidenceHash: 'v1:hash-1',
        evidence: null,
        state: 'outstanding',
        comparison: 'Unchanged',
      },
      3,
    );

    expect(assessment.factors.surface).toBeCloseTo(1.2, 10);
    expect(assessment.score).toBeCloseTo(5 * 0.8 * 0.85 * 1.2, 10);
    expect(assessment.source?.occurrenceKey).toBe('occurrence-1');
  });
});

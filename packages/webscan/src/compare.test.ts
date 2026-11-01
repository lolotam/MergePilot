import { describe, expect, it } from 'vitest';

import { ComparisonError, compareScan, findingFromIdentity, identityFromFinding } from './compare.js';
import type {
  CoverageEntry,
  OccurrenceFinding,
  RetainedOccurrence,
  RetainedOccurrenceIdentity,
  ScanObservation,
} from './types.js';

/** A finding of one occurrence. */
function finding(overrides: Partial<OccurrenceFinding> = {}): OccurrenceFinding {
  return {
    occurrenceKey: 'occurrence-1',
    targetKey: 'target-1',
    checkId: 'headers',
    checkVersion: 1,
    issueKey: 'headers|missing-strict-transport-security|example.com',
    issueId: 'missing-strict-transport-security',
    subject: 'strict-transport-security',
    severity: 'medium',
    validation: 'Confirmed',
    confidence: 'high',
    safeLocation: 'https://example.com/',
    evidenceHash: 'v1:hash-1',
    evidence: { header: 'strict-transport-security' },
    ...overrides,
  };
}

/** The retained identity of an archived occurrence. */
function identity(overrides: Partial<RetainedOccurrenceIdentity> = {}): RetainedOccurrenceIdentity {
  return identityFromFinding(finding(overrides));
}

/** A coverage row of a target and check. */
function row(overrides: Partial<CoverageEntry> = {}): CoverageEntry {
  return {
    targetKey: 'target-1',
    checkId: 'headers',
    checkVersion: 1,
    evaluatedIssueIds: ['missing-strict-transport-security'],
    outcome: 'checked',
    subjectScope: { kind: 'complete' },
    ...overrides,
  };
}

/** A scan observation with the given findings and coverage. */
function observation(overrides: Partial<ScanObservation> = {}): ScanObservation {
  return {
    status: 'completed',
    partialCoverage: false,
    requests: 3,
    pages: 1,
    durationMs: 120,
    findings: [],
    coverage: [],
    ...overrides,
  };
}

describe('the baseline of a scan', () => {
  it('is allowed only for a completed scan', () => {
    expect(compareScan(observation(), []).mayBecomeBaseline).toBe(true);
  });

  it('is refused for a stopped scan', () => {
    const result = compareScan(observation({ status: 'stopped', reason: 'request_limit' }), []);
    expect(result.mayBecomeBaseline).toBe(false);
  });

  it('is refused for a failed scan', () => {
    const result = compareScan(observation({ status: 'failed', reason: 'transport_error' }), []);
    expect(result.mayBecomeBaseline).toBe(false);
  });

  it('is allowed for a completed scan with partial coverage', () => {
    expect(compareScan(observation({ partialCoverage: true }), []).mayBecomeBaseline).toBe(true);
  });
});

describe('an observed occurrence', () => {
  it('is new when nothing was retained', () => {
    const result = compareScan(observation({ findings: [finding()] }), []);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'New', state: 'outstanding' },
    ]);
  });

  it('is unchanged when it was outstanding before', () => {
    const retained: RetainedOccurrence[] = [{ finding: finding(), state: 'outstanding' }];
    const result = compareScan(observation({ findings: [finding()] }), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Unchanged', state: 'outstanding' },
    ]);
  });

  it('is new again when a fixed occurrence reappears', () => {
    const retained: RetainedOccurrence[] = [{ finding: finding(), state: 'fixed' }];
    const result = compareScan(observation({ findings: [finding()] }), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'New', state: 'outstanding' },
    ]);
  });

  it('reactivates an archived occurrence', () => {
    const retained: RetainedOccurrence[] = [
      { identity: identity(), state: 'archived', archiveReason: 'unobserved_retention' },
    ];
    const result = compareScan(observation({ findings: [finding()] }), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'New', state: 'outstanding' },
    ]);
  });

  it('reactivates an archived occurrence from a stopped scan', () => {
    const retained: RetainedOccurrence[] = [
      { identity: identity(), state: 'archived', archiveReason: 'unobserved_retention' },
    ];
    const result = compareScan(
      observation({ status: 'stopped', reason: 'request_limit', findings: [finding()] }),
      retained,
    );
    expect(result.mayBecomeBaseline).toBe(false);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'New', state: 'outstanding' },
    ]);
  });

  it('keeps two cookies of one target apart', () => {
    const first = finding({ occurrenceKey: 'occurrence-session', subject: 'session' });
    const second = finding({ occurrenceKey: 'occurrence-tracker', subject: 'tracker' });
    const result = compareScan(observation({ findings: [first, second] }), []);
    expect(result.updates.map((update) => update.finding?.occurrenceKey)).toEqual([
      'occurrence-session',
      'occurrence-tracker',
    ]);
  });

  it('never lets a query variant fix another variant', () => {
    const variant = finding({ occurrenceKey: 'occurrence-a', targetKey: 'target-a' });
    const otherVariant = finding({ occurrenceKey: 'occurrence-b', targetKey: 'target-b' });
    const retained: RetainedOccurrence[] = [{ finding: variant, state: 'outstanding' }];

    const result = compareScan(
      observation({ findings: [otherVariant], coverage: [row({ targetKey: 'target-b' })] }),
      retained,
    );

    expect(result.updates).toEqual([
      { finding: variant, comparison: 'Not checked', state: 'outstanding' },
      { finding: otherVariant, comparison: 'New', state: 'outstanding' },
    ]);
  });
});

describe('an occurrence that was not observed', () => {
  const retained: RetainedOccurrence[] = [{ finding: finding(), state: 'outstanding' }];

  it('is fixed by a successful negative of a completed scan', () => {
    const result = compareScan(observation({ coverage: [row()] }), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Fixed', state: 'fixed' },
    ]);
  });

  it('is fixed by a newer version that evaluated the same issue id', () => {
    const result = compareScan(
      observation({ coverage: [row({ checkVersion: 2 })] }),
      retained,
    );
    expect(result.updates[0]).toMatchObject({ comparison: 'Fixed', state: 'fixed' });
  });

  it('is not checked when no coverage exists', () => {
    const result = compareScan(observation(), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Not checked', state: 'outstanding' },
    ]);
  });

  it('is not fixed by a stopped scan, even with a checked row', () => {
    const result = compareScan(
      observation({ status: 'stopped', reason: 'request_limit', coverage: [row()] }),
      retained,
    );
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Not checked', state: 'outstanding' },
    ]);
  });

  it('is not fixed by a failed scan, even with a checked row', () => {
    const result = compareScan(
      observation({ status: 'failed', reason: 'transport_error', coverage: [row()] }),
      retained,
    );
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Not checked', state: 'outstanding' },
    ]);
  });

  it.each([
    [
      'an error row',
      [row({ outcome: 'error', reason: 'target_error', evaluatedIssueIds: [] })],
    ],
    [
      'a not-visited row',
      [row({ outcome: 'not-visited', reason: 'disabled', evaluatedIssueIds: [] })],
    ],
    ['a checked row without issue ids', [row({ evaluatedIssueIds: [] })]],
    [
      'a checked row of another issue id',
      [row({ evaluatedIssueIds: ['missing-content-security-policy'] })],
    ],
    ['a checked row of another target', [row({ targetKey: 'target-2' })]],
    ['a checked row of another check', [row({ checkId: 'cookies' })]],
    [
      'a checked row whose scope does not cover the subject',
      [row({ subjectScope: { kind: 'restricted', subjects: ['other'] } })],
    ],
  ])('is not fixed by %s', (_case, coverage) => {
    const result = compareScan(observation({ coverage }), retained);
    expect(result.updates[0]).toMatchObject({ comparison: 'Not checked', state: 'outstanding' });
  });

  it('is fixed by a checked row whose restricted scope covers the subject', () => {
    const result = compareScan(
      observation({ coverage: [row({ subjectScope: { kind: 'restricted', subjects: ['strict-transport-security'] } })] }),
      retained,
    );
    expect(result.updates[0]).toMatchObject({ comparison: 'Fixed', state: 'fixed' });
  });

  it('is not fixed by a checked row without a subject scope', () => {
    const withoutScope = row();
    delete (withoutScope as { subjectScope?: unknown }).subjectScope;
    const result = compareScan(observation({ coverage: [withoutScope] }), retained);
    expect(result.updates[0]).toMatchObject({ comparison: 'Not checked', state: 'outstanding' });
  });

  it('keeps a positive observation over a negative row of the same occurrence', () => {
    const result = compareScan(observation({ findings: [finding()], coverage: [row()] }), retained);
    expect(result.updates).toEqual([
      { finding: finding(), comparison: 'Unchanged', state: 'outstanding' },
    ]);
  });

  it('never becomes outstanding again from a previously fixed row', () => {
    const fixed: RetainedOccurrence[] = [{ finding: finding(), state: 'fixed' }];
    const result = compareScan(observation(), fixed);
    expect(result.updates).toEqual([]);
  });
});

describe('an archived occurrence', () => {
  const archived: RetainedOccurrence[] = [
    { identity: identity(), state: 'archived', archiveReason: 'unobserved_retention' },
  ];

  it('keeps its historical Not checked state when nothing proves it', () => {
    const result = compareScan(observation(), archived);
    expect(result.updates).toEqual([
      {
        identity: identity(),
        comparison: 'Not checked',
        state: 'archived',
        archiveReason: 'unobserved_retention',
      },
    ]);
  });

  it('is fixed by a completed scan from its retained metadata', () => {
    const result = compareScan(observation({ coverage: [row()] }), archived);
    expect(result.updates).toEqual([
      {
        finding: { ...identity(), evidence: null },
        comparison: 'Fixed',
        state: 'fixed',
      },
    ]);
  });

  it('is never fixed by a stopped scan', () => {
    const result = compareScan(
      observation({ status: 'stopped', reason: 'request_limit', coverage: [row()] }),
      archived,
    );
    expect(result.updates[0]).toMatchObject({ comparison: 'Not checked', state: 'archived' });
  });

  it('is archived as retired when its issue id left the catalogue', () => {
    const retired: RetainedOccurrence[] = [
      {
        finding: finding({ issueId: 'retired-issue', evidenceHash: 'v1:retired' }),
        state: 'outstanding',
      },
    ];
    const result = compareScan(observation({ coverage: [row()] }), retired);
    expect(result.updates).toEqual([
      {
        identity: identityFromFinding(finding({ issueId: 'retired-issue', evidenceHash: 'v1:retired' })),
        comparison: 'Not checked',
        state: 'archived',
        archiveReason: 'retired_catalogue',
      },
    ]);
  });

  it('is never fixed by a version change', () => {
    const retired: RetainedOccurrence[] = [
      {
        finding: finding({ issueId: 'retired-issue' }),
        state: 'outstanding',
      },
    ];
    const result = compareScan(
      observation({
        coverage: [row({ evaluatedIssueIds: ['retired-issue'], checkVersion: 7 })],
      }),
      retired,
    );
    expect(result.updates[0]).toMatchObject({
      comparison: 'Not checked',
      state: 'archived',
      archiveReason: 'retired_catalogue',
    });
  });
});

describe('the updates of a comparison', () => {
  it.each(['outstanding', 'archived'] as const)('collapses identical retained %s rows into one update', (state) => {
    const retained: RetainedOccurrence = state === 'archived'
      ? { state, identity: identity(), archiveReason: 'unobserved_retention' }
      : { state, finding: finding() };

    const result = compareScan(observation({ coverage: [row()] }), [retained, structuredClone(retained)]);

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ state: 'fixed', comparison: 'Fixed' });
  });

  it.each<Partial<RetainedOccurrenceIdentity>>([
    { issueId: 'missing-content-security-policy' },
    { targetKey: 'another-target' },
    { severity: 'critical' },
  ])('rejects conflicting archived identity metadata: %j', (difference) => {
    const retained: RetainedOccurrence[] = [
      { state: 'archived', identity: identity(), archiveReason: 'unobserved_retention' },
      { state: 'archived', identity: identity(difference), archiveReason: 'unobserved_retention' },
    ];

    expect(() => compareScan(observation({ coverage: [row()] }), retained)).toThrow(ComparisonError);
  });

  it('are ordered by the occurrence key, whatever the order of the input', () => {
    const first = finding({ occurrenceKey: 'occurrence-b' });
    const second = finding({ occurrenceKey: 'occurrence-a' });
    const forward = compareScan(observation({ findings: [first, second] }), []);
    const backward = compareScan(observation({ findings: [second, first] }), []);
    expect(forward.updates.map((update) => update.finding?.occurrenceKey)).toEqual([
      'occurrence-a',
      'occurrence-b',
    ]);
    expect(backward.updates).toEqual(forward.updates);
  });

  it('collapse two identical findings of one occurrence', () => {
    const result = compareScan(observation({ findings: [finding(), finding()] }), []);
    expect(result.updates).toHaveLength(1);
  });

  it('reject two different findings of one occurrence', () => {
    expect(() =>
      compareScan(observation({ findings: [finding(), finding({ evidenceHash: 'v1:other' })] }), []),
    ).toThrow(ComparisonError);
  });

  it('reject two different retained rows of one occurrence', () => {
    const retained: RetainedOccurrence[] = [
      { finding: finding(), state: 'outstanding' },
      { finding: finding(), state: 'fixed' },
    ];
    expect(() => compareScan(observation(), retained)).toThrow(ComparisonError);
  });

  it('do not change the observation or the retained rows', () => {
    const current = observation({ findings: [finding()], coverage: [row()] });
    const retained: RetainedOccurrence[] = [{ finding: finding(), state: 'outstanding' }];
    const currentBefore = JSON.stringify(current);
    const retainedBefore = JSON.stringify(retained);

    compareScan(current, retained);

    expect(JSON.stringify(current)).toBe(currentBefore);
    expect(JSON.stringify(retained)).toBe(retainedBefore);
  });
});

describe('the retained identity', () => {
  it('becomes a finding with pruned evidence', () => {
    const restored = findingFromIdentity(identity());
    expect(restored.evidence).toBeNull();
    expect(restored.severity).toBe('medium');
    expect(restored.validation).toBe('Confirmed');
    expect(restored.confidence).toBe('high');
    expect(restored.safeLocation).toBe('https://example.com/');
    expect(restored.evidenceHash).toBe('v1:hash-1');
  });

  it('becomes an identity without its evidence', () => {
    const derived = identityFromFinding(finding());
    expect(derived).not.toHaveProperty('evidence');
    expect(derived.occurrenceKey).toBe('occurrence-1');
  });
});

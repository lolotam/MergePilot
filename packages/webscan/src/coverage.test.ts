import { describe, expect, it } from 'vitest';

import {
  findNegativeProof,
  indexCoverage,
  occurrenceCoverage,
  rowProvesAbsence,
  scopeCoversSubject,
  summarizeCoverage,
} from './coverage.js';
import type { CheckId, CoverageEntry } from './types.js';

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

describe('the subject scope of a coverage row', () => {
  it('covers every subject when it is complete', () => {
    expect(scopeCoversSubject({ kind: 'complete' }, 'session')).toBe(true);
    expect(scopeCoversSubject({ kind: 'complete' }, 'anything')).toBe(true);
  });

  it('covers only the subjects it names when it is restricted', () => {
    const scope = { kind: 'restricted', subjects: ['q'] } as const;
    expect(scopeCoversSubject(scope, 'q')).toBe(true);
    expect(scopeCoversSubject(scope, 'page')).toBe(false);
  });

  it('covers no subject when the scope is unknown', () => {
    expect(scopeCoversSubject(undefined, 'q')).toBe(false);
  });

  it('never compares a value instead of a name', () => {
    const scope = { kind: 'restricted', subjects: ['q'] } as const;
    expect(scopeCoversSubject(scope, 'books')).toBe(false);
  });
});

describe('a successful negative', () => {
  it('needs a checked outcome that evaluated the issue id', () => {
    expect(rowProvesAbsence(row(), 'missing-strict-transport-security', 'hsts')).toBe(true);
    expect(rowProvesAbsence(row(), 'missing-content-security-policy', 'hsts')).toBe(false);
  });

  it('never comes from an error or a not-visited row', () => {
    expect(
      rowProvesAbsence(
        row({ outcome: 'error', reason: 'target_error', evaluatedIssueIds: ['missing-strict-transport-security'] }),
        'missing-strict-transport-security',
        'hsts',
      ),
    ).toBe(false);
    expect(
      rowProvesAbsence(
        row({ outcome: 'not-visited', reason: 'disabled', evaluatedIssueIds: ['missing-strict-transport-security'] }),
        'missing-strict-transport-security',
        'hsts',
      ),
    ).toBe(false);
  });

  it('never comes from a row without a scope', () => {
    const withoutScope = row();
    delete (withoutScope as { subjectScope?: unknown }).subjectScope;
    expect(rowProvesAbsence(withoutScope, 'missing-strict-transport-security', 'hsts')).toBe(false);
  });

  it('never comes from a checked row without issue ids', () => {
    expect(rowProvesAbsence(row({ evaluatedIssueIds: [] }), 'missing-strict-transport-security', 'hsts')).toBe(
      false,
    );
  });

  it('never comes from a row of another target, check or subject', () => {
    const index = indexCoverage([
      row({ targetKey: 'target-2' }),
      row({ checkId: 'cookies' }),
      row({ subjectScope: { kind: 'restricted', subjects: ['other'] } }),
    ]);
    expect(
      findNegativeProof(index, {
        targetKey: 'target-1',
        checkId: 'headers',
        issueId: 'missing-strict-transport-security',
        subject: 'hsts',
      }),
    ).toBeUndefined();
  });

  it('accepts one of several rows of the same target and check', () => {
    const index = indexCoverage([
      row({ subjectScope: { kind: 'restricted', subjects: ['other'] } }),
      row({ subjectScope: { kind: 'restricted', subjects: ['q'] } }),
    ]);
    const proof = findNegativeProof(index, {
      targetKey: 'target-1',
      checkId: 'headers',
      issueId: 'missing-strict-transport-security',
      subject: 'q',
    });
    expect(proof?.subjectScope).toEqual({ kind: 'restricted', subjects: ['q'] });
  });
});

describe('the coverage record of one occurrence', () => {
  it('is positive when the issue was observed', () => {
    const record = occurrenceCoverage(
      { targetKey: 'target-1', checkId: 'headers', issueId: 'missing-strict-transport-security', subject: 'hsts' },
      [row()],
      true,
    );
    expect(record.verdict).toBe('positive');
  });

  it('is negative when the issue was evaluated and is absent', () => {
    const record = occurrenceCoverage(
      { targetKey: 'target-1', checkId: 'headers', issueId: 'missing-strict-transport-security', subject: 'hsts' },
      [row()],
      false,
    );
    expect(record.verdict).toBe('negative');
  });

  it('is an error when the evaluation failed', () => {
    const record = occurrenceCoverage(
      { targetKey: 'target-1', checkId: 'headers', issueId: 'missing-strict-transport-security', subject: 'hsts' },
      [row({ outcome: 'error', reason: 'target_error', evaluatedIssueIds: [] })],
      false,
    );
    expect(record.verdict).toBe('error');
  });

  it('is not visited when the target was never visited', () => {
    const record = occurrenceCoverage(
      { targetKey: 'target-1', checkId: 'headers', issueId: 'missing-strict-transport-security', subject: 'hsts' },
      [row({ outcome: 'not-visited', reason: 'not_visited', evaluatedIssueIds: [] })],
      false,
    );
    expect(record.verdict).toBe('not-visited');
  });

  it('is unknown when nothing says anything about the issue', () => {
    const record = occurrenceCoverage(
      { targetKey: 'target-1', checkId: 'headers', issueId: 'missing-strict-transport-security', subject: 'hsts' },
      [row({ evaluatedIssueIds: ['missing-content-security-policy'] })],
      false,
    );
    expect(record.verdict).toBe('unknown');
  });
});

describe('the coverage summary', () => {
  it('counts the outcomes and the subject scopes of every check', () => {
    const summary = summarizeCoverage([
      row(),
      row({ checkId: 'cookies', subjectScope: { kind: 'restricted', subjects: ['session'] } }),
      row({ checkId: 'files', outcome: 'error', reason: 'target_error', evaluatedIssueIds: [] }),
      row({ checkId: 'active', outcome: 'not-visited', reason: 'not_visited', evaluatedIssueIds: [] }),
    ]);

    expect(summary.rows).toBe(4);
    expect(summary.checked).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.notVisited).toBe(1);
    expect(summary.byCheck).toHaveLength(6);
    const headers = summary.byCheck.find((entry) => entry.checkId === 'headers');
    expect(headers).toEqual({
      checkId: 'headers',
      checked: 1,
      errors: 0,
      notVisited: 0,
      complete: 1,
      restricted: 0,
      unknown: 0,
    });
    const cookies = summary.byCheck.find((entry) => entry.checkId === 'cookies');
    expect(cookies?.restricted).toBe(1);
  });

  it('counts a row without a scope as an unknown scope', () => {
    const withoutScope = row();
    delete (withoutScope as { subjectScope?: unknown }).subjectScope;
    const summary = summarizeCoverage([withoutScope]);
    const headers = summary.byCheck.find((entry) => entry.checkId === 'headers');
    expect(headers?.unknown).toBe(1);
    expect(headers?.complete).toBe(0);
  });

  it('never calls an unchecked row a negative', () => {
    const summary = summarizeCoverage([row({ outcome: 'not-visited', reason: 'disabled', evaluatedIssueIds: [] })]);
    expect(summary.checked).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('Fixed');
  });
});

describe('the check ids of the summary', () => {
  it('covers every check of the catalogue', () => {
    const summary = summarizeCoverage([]);
    expect(summary.byCheck.map((entry) => entry.checkId)).toEqual<CheckId[]>([
      'headers',
      'cookies',
      'transport',
      'disclosure',
      'files',
      'active',
    ]);
  });
});

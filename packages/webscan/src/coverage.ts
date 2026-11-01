/**
 * The coverage semantics of one scan (ADR-0052 sections 3, 4 and 11).
 *
 * Coverage is what a check could and could not establish for one target. It is
 * the only thing that may prove that a previous occurrence is gone, so its
 * rules are strict:
 *
 * - A row supplies a **successful negative** only when the row is `checked`,
 *   the immutable issue id is in its `evaluatedIssueIds`, and the subject scope
 *   of the row covers the subject of the occurrence.
 * - A `complete` scope covers every subject of the target. A `restricted` scope
 *   covers only the subjects it names, and a row without a scope covers none:
 *   its scope is unknown, so it can never prove an absence.
 * - An `error` row and a `not-visited` row never prove anything, not even when
 *   they name issue ids.
 * - A positive observation always wins: an issue that was seen is not absent,
 *   whatever else the ledger says.
 *
 * Nothing here reads a raw URL. The scope of a row is the proof of a subject,
 * never a part of the identity of an occurrence.
 */

import { CHECK_IDS } from './evaluation.js';
import type { CheckId, CoverageEntry, CoverageSubjectScope } from './types.js';

/**
 * Whether the subject scope of a row covers one subject.
 *
 * A complete scope covers every subject of the target, a restricted scope
 * covers only the subjects it names, and an unknown scope covers none.
 */
export function scopeCoversSubject(
  scope: CoverageSubjectScope | undefined,
  subject: string,
): boolean {
  if (scope === undefined) {
    return false;
  }
  if (scope.kind === 'complete') {
    return true;
  }
  return scope.subjects.includes(subject);
}

/**
 * Whether a row proves the absence of an issue on a subject.
 *
 * The row must be a checked one, it must have evaluated the immutable issue
 * id, and its subject scope must cover the subject.
 */
export function rowProvesAbsence(
  row: CoverageEntry,
  issueId: string,
  subject: string,
): boolean {
  if (row.outcome !== 'checked') {
    return false;
  }
  if (!row.evaluatedIssueIds.includes(issueId)) {
    return false;
  }
  return scopeCoversSubject(row.subjectScope, subject);
}

/** The rows of one target and check. */
export interface CoverageIndex {
  /** Every row of one target and check, in the order of the scan. */
  rowsFor: (targetKey: string, checkId: CheckId) => readonly CoverageEntry[];
}

/**
 * Indexes the coverage rows of a scan.
 *
 * Several rows of one target and check are valid when their subject scopes
 * differ, so the index keeps all of them and never flattens them into one.
 */
export function indexCoverage(rows: readonly CoverageEntry[]): CoverageIndex {
  const groups = new Map<string, CoverageEntry[]>();
  for (const row of rows) {
    const key = `${row.targetKey}|${row.checkId}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [row]);
      continue;
    }
    group.push(row);
  }
  return {
    rowsFor: (targetKey, checkId) => groups.get(`${targetKey}|${checkId}`) ?? [],
  };
}

/** The occurrence a proof is searched for. */
export interface NegativeProofRequest {
  readonly targetKey: string;
  readonly checkId: CheckId;
  /** The immutable catalogue issue id. */
  readonly issueId: string;
  /** The stable subject of the occurrence, for example a cookie name. */
  readonly subject: string;
}

/**
 * Finds the row that proves the absence of an issue on a subject.
 *
 * The first matching row wins. When several rows of the same target and check
 * match, they all prove the same absence: the proof is the absence, not the
 * row.
 */
export function findNegativeProof(
  index: CoverageIndex,
  request: NegativeProofRequest,
): CoverageEntry | undefined {
  for (const row of index.rowsFor(request.targetKey, request.checkId)) {
    if (rowProvesAbsence(row, request.issueId, request.subject)) {
      return row;
    }
  }
  return undefined;
}

/** What the coverage of one occurrence scope establishes. */
export type CoverageVerdict =
  /** The issue was observed on the subject. */
  | 'positive'
  /** The issue was evaluated on the subject and is absent. */
  | 'negative'
  /** The target was not visited. */
  | 'not-visited'
  /** The evaluation of the target failed. */
  | 'error'
  /** Nothing says anything about the issue. */
  | 'unknown';

/** The occurrence scope a coverage record describes. */
export interface CoverageQuery {
  readonly targetKey: string;
  readonly checkId: CheckId;
  readonly issueId: string;
  readonly subject: string;
}

/** The coverage record of one occurrence scope. */
export interface OccurrenceCoverage {
  readonly targetKey: string;
  readonly checkId: CheckId;
  readonly issueId: string;
  readonly subject: string;
  readonly verdict: CoverageVerdict;
  /** The rows the verdict was read from. */
  readonly rows: readonly CoverageEntry[];
}

/**
 * Builds the coverage record of one occurrence scope.
 *
 * A positive observation wins over every row. Without one, the successful
 * negative rows decide, then the failed rows, then the rows of a target that
 * was never visited. A row that says nothing about the issue leaves the scope
 * unknown.
 */
export function occurrenceCoverage(
  query: CoverageQuery,
  coverage: readonly CoverageEntry[],
  observed: boolean,
): OccurrenceCoverage {
  const rows = coverage.filter(
    (row) => row.targetKey === query.targetKey && row.checkId === query.checkId,
  );
  const verdict = verdictOf(query, rows, observed);
  return {
    targetKey: query.targetKey,
    checkId: query.checkId,
    issueId: query.issueId,
    subject: query.subject,
    verdict,
    rows,
  };
}

/** The verdict of the rows of one target and check. */
function verdictOf(
  query: CoverageQuery,
  rows: readonly CoverageEntry[],
  observed: boolean,
): CoverageVerdict {
  if (observed) {
    return 'positive';
  }
  if (rows.some((row) => rowProvesAbsence(row, query.issueId, query.subject))) {
    return 'negative';
  }
  if (rows.some((row) => row.outcome === 'error')) {
    return 'error';
  }
  if (rows.some((row) => row.outcome === 'not-visited')) {
    return 'not-visited';
  }
  return 'unknown';
}

/** The coverage of one check. */
export interface CheckCoverageSummary {
  readonly checkId: CheckId;
  readonly checked: number;
  readonly errors: number;
  readonly notVisited: number;
  /** The rows that cover every subject of their target. */
  readonly complete: number;
  /** The rows that cover only the subjects they name. */
  readonly restricted: number;
  /** The rows whose subject scope is unknown. */
  readonly unknown: number;
}

/** The coverage summary of a scan. */
export interface CoverageSummary {
  readonly rows: number;
  readonly checked: number;
  readonly errors: number;
  readonly notVisited: number;
  readonly byCheck: readonly CheckCoverageSummary[];
}

/**
 * Summarizes the coverage rows of a scan.
 *
 * The summary counts outcomes and subject scopes. It never calls a row a
 * negative: only the comparison of ADR-0052 section 4 may conclude that an
 * occurrence is Fixed, and only from a successful negative of a completed run.
 */
export function summarizeCoverage(rows: readonly CoverageEntry[]): CoverageSummary {
  const byCheck = new Map<CheckId, MutableCheckCoverage>();
  for (const checkId of CHECK_IDS) {
    byCheck.set(checkId, {
      checkId,
      checked: 0,
      errors: 0,
      notVisited: 0,
      complete: 0,
      restricted: 0,
      unknown: 0,
    });
  }
  let checked = 0;
  let errors = 0;
  let notVisited = 0;
  for (const row of rows) {
    const entry = byCheck.get(row.checkId);
    if (entry === undefined) {
      continue;
    }
    if (row.outcome === 'checked') {
      checked += 1;
      entry.checked += 1;
    } else if (row.outcome === 'error') {
      errors += 1;
      entry.errors += 1;
    } else {
      notVisited += 1;
      entry.notVisited += 1;
    }
    if (row.subjectScope === undefined) {
      entry.unknown += 1;
    } else if (row.subjectScope.kind === 'complete') {
      entry.complete += 1;
    } else {
      entry.restricted += 1;
    }
  }
  return {
    rows: rows.length,
    checked,
    errors,
    notVisited,
    byCheck: CHECK_IDS.map((checkId) => byCheck.get(checkId)!),
  };
}

/** The mutable counter of one check while the summary is built. */
interface MutableCheckCoverage {
  readonly checkId: CheckId;
  checked: number;
  errors: number;
  notVisited: number;
  complete: number;
  restricted: number;
  unknown: number;
}

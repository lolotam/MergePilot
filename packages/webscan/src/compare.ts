/**
 * The comparison of a new scan with the retained state (ADR-0052 section 4).
 *
 * Scanning and comparing are separate operations. `compareScan` is a pure
 * boundary: it takes what a scan observed and what the site retained, and it
 * returns the changes of the retained ledger. It never reads a raw URL, a
 * query value or a response body, and it never talks to a store.
 *
 * The rules are the ones of ADR-0052 section 4 and section 11:
 *
 * - Only a **completed** scan may become the baseline, and only a completed
 *   scan may prove that an occurrence is Fixed. A stopped or a failed scan
 *   keeps every outstanding occurrence outstanding, even when its coverage
 *   says `checked`.
 * - An occurrence that was observed is outstanding. A positive observation
 *   wins over a negative row of the same occurrence.
 * - An occurrence that was not observed is Fixed only when a completed scan
 *   proved its absence: the same target, the same check, a checked coverage
 *   row that evaluated the same immutable issue id, and a subject scope that
 *   covers the subject of the occurrence.
 * - An archived occurrence keeps its historical Not checked state until it is
 *   re-observed or proven Fixed. A proof builds the finding from the retained
 *   metadata with `evidence: null`, never from a fabricated finding.
 * - An issue id that left the catalogue is archived as `retired_catalogue`. A
 *   retired id is never Fixed, and a version change never retires an id.
 */

import { findCatalogueIssue } from './checks/catalogue.js';
import { findNegativeProof, indexCoverage, type CoverageIndex } from './coverage.js';
import { compareCodeUnits } from './urls.js';
import type {
  Comparison,
  ComparisonResult,
  ComparisonUpdate,
  OccurrenceFinding,
  OccurrenceRecord,
  OccurrenceState,
  RetainedOccurrence,
  RetainedOccurrenceIdentity,
  ScanObservation,
} from './types.js';

/** A record that contradicts itself. */
export class ComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonError';
  }
}

/** The identity of a finding, without its evidence body. */
export function identityFromFinding(finding: OccurrenceFinding): RetainedOccurrenceIdentity {
  return {
    occurrenceKey: finding.occurrenceKey,
    targetKey: finding.targetKey,
    checkId: finding.checkId,
    checkVersion: finding.checkVersion,
    issueKey: finding.issueKey,
    issueId: finding.issueId,
    subject: finding.subject,
    severity: finding.severity,
    validation: finding.validation,
    confidence: finding.confidence,
    safeLocation: finding.safeLocation,
    evidenceHash: finding.evidenceHash,
  };
}

/**
 * Rebuilds a finding from a retained identity.
 *
 * The identity carries every safe field of the finding except its evidence
 * body, so the rebuilt finding takes its severity, validation, confidence,
 * location and evidence hash from the retained metadata and marks the pruned
 * evidence explicitly with `null`. No value is ever fabricated.
 */
export function findingFromIdentity(identity: RetainedOccurrenceIdentity): OccurrenceFinding {
  return { ...identity, evidence: null };
}

/**
 * The occurrence record of a finding, for the display layer.
 *
 * The record is what the grouping and the report read: the safe metadata of
 * the occurrence, its state in the ledger and its comparison against the last
 * scan.
 */
export function occurrenceRecordFromFinding(
  finding: OccurrenceFinding,
  state: OccurrenceState,
  comparison: Comparison,
): OccurrenceRecord {
  return {
    occurrenceKey: finding.occurrenceKey,
    targetKey: finding.targetKey,
    issueKey: finding.issueKey,
    checkId: finding.checkId,
    issueId: finding.issueId,
    subject: finding.subject,
    severity: finding.severity,
    validation: finding.validation,
    confidence: finding.confidence,
    safeLocation: finding.safeLocation,
    evidenceHash: finding.evidenceHash,
    evidence: finding.evidence,
    state,
    comparison,
  };
}

/** The occurrence key of a retained row. */
function occurrenceKeyOf(retained: RetainedOccurrence): string {
  return retained.state === 'archived' ? retained.identity.occurrenceKey : retained.finding.occurrenceKey;
}

/** Whether two evidence records hold the same facts. */
function sameEvidence(
  left: Readonly<Record<string, string | number | boolean>> | null,
  right: Readonly<Record<string, string | number | boolean>> | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
}

/** Whether two findings of one occurrence carry the same safe metadata. */
function sameFinding(left: OccurrenceFinding, right: OccurrenceFinding): boolean {
  return (
    left.targetKey === right.targetKey &&
    left.checkId === right.checkId &&
    left.checkVersion === right.checkVersion &&
    left.issueKey === right.issueKey &&
    left.issueId === right.issueId &&
    left.subject === right.subject &&
    left.severity === right.severity &&
    left.validation === right.validation &&
    left.confidence === right.confidence &&
    left.safeLocation === right.safeLocation &&
    left.evidenceHash === right.evidenceHash &&
    sameEvidence(left.evidence, right.evidence)
  );
}

/**
 * Indexes the findings of a scan by their occurrence key.
 *
 * Two findings of one occurrence key that carry the same safe metadata are one
 * observation. Two that differ are an inconsistent record, and an inconsistent
 * record is rejected instead of one of them silently overwriting the other.
 */
function indexFindings(findings: readonly OccurrenceFinding[]): Map<string, OccurrenceFinding> {
  const index = new Map<string, OccurrenceFinding>();
  for (const finding of findings) {
    const known = index.get(finding.occurrenceKey);
    if (known === undefined) {
      index.set(finding.occurrenceKey, finding);
      continue;
    }
    if (!sameFinding(known, finding)) {
      throw new ComparisonError(
        `two different findings share the occurrence key ${finding.occurrenceKey}.`,
      );
    }
  }
  return index;
}

/**
 * Indexes the retained rows by their occurrence key.
 *
 * The store keeps one row per occurrence key, so two rows of one key are an
 * inconsistent record and are rejected.
 */
function indexRetained(retained: readonly RetainedOccurrence[]): Map<string, RetainedOccurrence> {
  const index = new Map<string, RetainedOccurrence>();
  for (const row of retained) {
    const key = occurrenceKeyOf(row);
    const known = index.get(key);
    if (known === undefined) {
      index.set(key, row);
      continue;
    }
    if (!sameRetained(known, row)) {
      throw new ComparisonError(`two different retained rows share the occurrence key ${key}.`);
    }
  }
  return index;
}

/** Whether two retained rows of one occurrence carry the same record. */
function sameRetained(left: RetainedOccurrence, right: RetainedOccurrence): boolean {
  if (left.state !== right.state) {
    return false;
  }
  if (left.state === 'archived' && right.state === 'archived') {
    return (
      left.archiveReason === right.archiveReason &&
      sameFinding(findingFromIdentity(left.identity), findingFromIdentity(right.identity))
    );
  }
  if (left.state === 'archived' || right.state === 'archived') {
    return false;
  }
  return sameFinding(left.finding, right.finding);
}

/**
 * The comparison of an observed occurrence.
 *
 * An occurrence that was outstanding and is observed again is unchanged. An
 * occurrence that was fixed, or that was archived and is now observed, is new
 * again: it is outstanding from now on.
 */
function comparisonOf(retained: RetainedOccurrence | undefined): 'New' | 'Unchanged' {
  if (retained === undefined || retained.state !== 'outstanding') {
    return 'New';
  }
  return 'Unchanged';
}

/**
 * Compares a current observation with the retained state of a site.
 *
 * The result is the set of changes of the retained ledger. Nothing is
 * written, nothing is fetched and nothing is remembered: the caller stores
 * the result.
 */
export function compareScan(
  current: ScanObservation,
  retained: readonly RetainedOccurrence[],
): ComparisonResult {
  const completed = current.status === 'completed';
  const coverage = indexCoverage(current.coverage);
  const observed = indexFindings(current.findings);
  const retainedByKey = indexRetained(retained);
  const updates = [
    ...observedUpdates(observed, retainedByKey),
    ...unobservedUpdates([...retainedByKey.values()], observed, completed, coverage),
  ];
  updates.sort((left, right) => compareCodeUnits(occurrenceKeyOfUpdate(left), occurrenceKeyOfUpdate(right)));
  return { mayBecomeBaseline: completed, updates };
}

/**
 * The updates of the occurrences the scan observed.
 *
 * A positive observation is direct evidence, so it is permitted from any
 * terminal run: a stopped scan is not a baseline and still reactivates.
 */
function observedUpdates(
  observed: Map<string, OccurrenceFinding>,
  retainedByKey: Map<string, RetainedOccurrence>,
): ComparisonUpdate[] {
  return [...observed.values()].map((finding) => ({
    finding,
    comparison: comparisonOf(retainedByKey.get(finding.occurrenceKey)),
    state: 'outstanding',
  }));
}

/**
 * The updates of the retained occurrences the scan did not observe.
 *
 * An occurrence that was already fixed produces no update: its state did not
 * change, and a Fixed update always means that this run proved the occurrence
 * absent. A historical Fixed is therefore never reported as a new proof.
 */
function unobservedUpdates(
  retained: readonly RetainedOccurrence[],
  observed: Map<string, OccurrenceFinding>,
  completed: boolean,
  coverage: CoverageIndex,
): ComparisonUpdate[] {
  const updates: ComparisonUpdate[] = [];
  for (const row of retained) {
    if (observed.has(occurrenceKeyOf(row))) {
      // A positive observation wins over every negative row.
      continue;
    }
    if (row.state === 'fixed') {
      continue;
    }
    const update = updateForUnobserved(row, completed, coverage);
    if (update !== undefined) {
      updates.push(update);
    }
  }
  return updates;
}

/** The occurrence key of an update. */
function occurrenceKeyOfUpdate(update: ComparisonUpdate): string {
  return update.state === 'archived' ? update.identity.occurrenceKey : update.finding.occurrenceKey;
}

/** The update of a retained occurrence that was not observed. */
function updateForUnobserved(
  row: RetainedOccurrence,
  completed: boolean,
  coverage: CoverageIndex,
): ComparisonUpdate | undefined {
  const identity =
    row.state === 'archived' ? row.identity : identityFromFinding(row.finding);
  const known = findCatalogueIssue(identity.checkId, identity.issueId);
  if (known === undefined) {
    // A retired issue id is archived, never Fixed. A version change never
    // retires an id by itself, and a retirement never remediates one.
    return {
      identity,
      comparison: 'Not checked',
      state: 'archived',
      archiveReason: 'retired_catalogue',
    };
  }
  const proof = completed
    ? findNegativeProof(coverage, {
        targetKey: identity.targetKey,
        checkId: identity.checkId,
        issueId: identity.issueId,
        subject: identity.subject,
      })
    : undefined;
  if (proof !== undefined) {
    return {
      finding: row.state === 'archived' ? findingFromIdentity(identity) : row.finding,
      comparison: 'Fixed',
      state: 'fixed',
    };
  }
  if (row.state === 'archived') {
    return {
      identity,
      comparison: 'Not checked',
      state: 'archived',
      archiveReason: row.archiveReason,
    };
  }
  return { finding: row.finding, comparison: 'Not checked', state: 'outstanding' };
}

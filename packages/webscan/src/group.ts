/**
 * The display grouping of the occurrences of a site (ADR-0052 section 4).
 *
 * The group is a view, never a change of identity. The occurrences of one
 * issue on one site share a group, and the group keeps every per-occurrence
 * key, evidence hash, subject, state and comparison, so an unchecked URL never
 * disappears behind a site-wide group.
 *
 * The group also owns the administrator resolutions of ADR-0052 section 9. A
 * resolution applies only while the occurrence key and the evidence hash both
 * match and it has not expired. An excepted finding stays visible and stays
 * labelled: it is never marked Fixed and never removed. A resolution is not a
 * remediation, so a group that is only resolved by exception is never Fixed.
 */

import { compareCodeUnits } from './urls.js';
import type {
  ExceptionKind,
  OccurrenceRecord,
  ScanException,
  Severity,
} from './types.js';

/** How many redacted evidence samples one group keeps. */
export const MAX_EVIDENCE_SAMPLES = 5;

/** One occurrence of a group, with the resolution that covers it. */
export interface GroupOccurrence extends OccurrenceRecord {
  /** The live administrator resolution of the occurrence, when there is one. */
  readonly exception?: ExceptionKind;
}

/** One redacted evidence sample of a group. */
export interface EvidenceSample {
  readonly occurrenceKey: string;
  readonly subject: string;
  readonly safeLocation: string;
  readonly evidenceHash: string;
  /** `null` means the evidence body was pruned, never an empty finding. */
  readonly evidence: Readonly<Record<string, string | number | boolean>> | null;
}

/**
 * The state of a group.
 *
 * - `fixed`: every member of the group was proven fixed.
 * - `open`: at least one member is outstanding and unresolved.
 * - `blocked`: an archived member was never proven fixed, so the Fixed
 *   conclusion of the group stays deferred.
 * - `resolved_by_exception`: every unresolved member carries a live
 *   administrator resolution. It is not Fixed.
 */
export type GroupStatus = 'fixed' | 'open' | 'blocked' | 'resolved_by_exception';

/** One issue group of a site. */
export interface IssueGroup {
  readonly issueKey: string;
  readonly checkId: OccurrenceRecord['checkId'];
  readonly issueId: string;
  readonly severity: Severity;
  readonly status: GroupStatus;
  /** Whether every member of the group was proven fixed. */
  readonly fixed: boolean;
  readonly occurrences: readonly GroupOccurrence[];
  readonly outstandingCount: number;
  readonly exceptedCount: number;
  readonly fixedCount: number;
  /** The archived members that were never proven fixed. */
  readonly archivedUnverifiedCount: number;
  /** The distinct targets of the members that count for the active risk. */
  readonly affectedTargets: number;
  readonly evidenceSamples: readonly EvidenceSample[];
  /** The occurrence keys that keep the group from being Fixed. */
  readonly blockers: readonly string[];
}

/** The options of one grouping. */
export interface GroupOptions {
  /** The resolutions that are live at the given moment. */
  readonly exceptions?: readonly ScanException[];
  /** The current time in epoch milliseconds, injected by the caller. */
  readonly now: number;
}

/** The severities, from the strongest to the weakest. */
const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Whether a resolution covers an occurrence.
 *
 * The occurrence key and the evidence hash must both match, and the
 * resolution must not have expired.
 */
export function exceptionApplies(
  exception: ScanException,
  occurrence: { occurrenceKey: string; evidenceHash: string },
  now: number,
): boolean {
  if (exception.occurrenceKey !== occurrence.occurrenceKey) {
    return false;
  }
  if (exception.evidenceHash !== occurrence.evidenceHash) {
    return false;
  }
  if (exception.expiresAt !== null && exception.expiresAt <= now) {
    return false;
  }
  return true;
}

/**
 * The resolution that covers an occurrence, when there is one.
 *
 * When several resolutions cover the same occurrence, the one that lives
 * longest wins, so a short resolution never hides a long one.
 */
function coveringException(
  occurrence: OccurrenceRecord,
  exceptions: readonly ScanException[],
  now: number,
): ExceptionKind | undefined {
  let found: ScanException | undefined;
  for (const candidate of exceptions) {
    if (!exceptionApplies(candidate, occurrence, now)) {
      continue;
    }
    if (found === undefined || longerLived(candidate, found)) {
      found = candidate;
    }
  }
  return found?.kind;
}

/** Whether one resolution lives longer than another. */
function longerLived(candidate: ScanException, known: ScanException): boolean {
  const candidateExpiry = candidate.expiresAt ?? Number.POSITIVE_INFINITY;
  const knownExpiry = known.expiresAt ?? Number.POSITIVE_INFINITY;
  if (candidateExpiry !== knownExpiry) {
    return candidateExpiry > knownExpiry;
  }
  return compareCodeUnits(candidate.kind, known.kind) < 0;
}

/** The severity of a group: the strongest severity of its members. */
function groupSeverity(occurrences: readonly GroupOccurrence[]): Severity {
  let strongest = occurrences[0]!.severity;
  for (const occurrence of occurrences) {
    if (SEVERITY_ORDER.indexOf(occurrence.severity) < SEVERITY_ORDER.indexOf(strongest)) {
      strongest = occurrence.severity;
    }
  }
  return strongest;
}

/**
 * The members of a group that count for its active risk.
 *
 * An outstanding member without a resolution is active. An archived member
 * has no evidence and never carries a risk, and a resolution removes the
 * member from the active risk without removing it from the group.
 */
export function activeOccurrences(group: IssueGroup): readonly GroupOccurrence[] {
  return group.occurrences.filter(
    (occurrence) => occurrence.state === 'outstanding' && occurrence.exception === undefined,
  );
}

/** The order of the evidence samples of a group. */
function compareSamples(left: EvidenceSample, right: EvidenceSample): number {
  const byLocation = compareCodeUnits(left.safeLocation, right.safeLocation);
  if (byLocation !== 0) {
    return byLocation;
  }
  const bySubject = compareCodeUnits(left.subject, right.subject);
  if (bySubject !== 0) {
    return bySubject;
  }
  return compareCodeUnits(left.occurrenceKey, right.occurrenceKey);
}

/**
 * Groups the occurrences of a site for display.
 *
 * The groups are ordered by their issue key and their members by their
 * occurrence key, so the result never depends on the order of the input.
 */
export function groupOccurrences(
  records: readonly OccurrenceRecord[],
  options: GroupOptions,
): readonly IssueGroup[] {
  const exceptions = options.exceptions ?? [];
  const grouped = new Map<string, GroupOccurrence[]>();
  for (const record of records) {
    const kind = coveringException(record, exceptions, options.now);
    const occurrence: GroupOccurrence =
      kind === undefined ? { ...record } : { ...record, exception: kind };
    const group = grouped.get(record.issueKey);
    if (group === undefined) {
      grouped.set(record.issueKey, [occurrence]);
      continue;
    }
    group.push(occurrence);
  }
  return [...grouped.keys()]
    .sort(compareCodeUnits)
    .map((issueKey) => buildGroup(issueKey, grouped.get(issueKey)!));
}

/** Builds one group of its members. */
function buildGroup(issueKey: string, occurrences: readonly GroupOccurrence[]): IssueGroup {
  const members = [...occurrences].sort((left, right) =>
    compareCodeUnits(left.occurrenceKey, right.occurrenceKey),
  );
  const fixed = members.filter((occurrence) => occurrence.state === 'fixed');
  const outstanding = members.filter((occurrence) => occurrence.state === 'outstanding');
  const archived = members.filter((occurrence) => occurrence.state === 'archived');
  const unresolved = members.filter((occurrence) => occurrence.state !== 'fixed');
  const excepted = unresolved.filter((occurrence) => occurrence.exception !== undefined);
  const unresolvedActive = outstanding.filter((occurrence) => occurrence.exception === undefined);
  const unresolvedArchived = archived.filter((occurrence) => occurrence.exception === undefined);
  const affectedTargets = new Set(unresolvedActive.map((occurrence) => occurrence.targetKey)).size;
  const status = statusOf(unresolvedActive, unresolvedArchived, excepted);
  return {
    issueKey,
    checkId: members[0]!.checkId,
    issueId: members[0]!.issueId,
    severity: groupSeverity(members),
    status,
    fixed: status === 'fixed',
    occurrences: members,
    outstandingCount: outstanding.length,
    exceptedCount: excepted.length,
    fixedCount: fixed.length,
    archivedUnverifiedCount: unresolvedArchived.length,
    affectedTargets,
    evidenceSamples: samplesOf(members),
    blockers: blockersOf(unresolvedActive, unresolvedArchived),
  };
}

/**
 * The status of a group.
 *
 * A group is Fixed only when every member was proven fixed. A member that
 * carries a resolution is not proven fixed, so it keeps the group out of the
 * Fixed conclusion. An archived member that was never proven fixed keeps the
 * Fixed conclusion deferred, so a new target never erases the old blocker. A
 * group whose remaining members all carry a resolution is resolved by
 * exception, never Fixed.
 */
function statusOf(
  unresolvedActive: readonly GroupOccurrence[],
  unresolvedArchived: readonly GroupOccurrence[],
  excepted: readonly GroupOccurrence[],
): GroupStatus {
  if (unresolvedActive.length === 0 && unresolvedArchived.length === 0 && excepted.length === 0) {
    return 'fixed';
  }
  if (unresolvedArchived.length > 0) {
    return 'blocked';
  }
  if (unresolvedActive.length > 0) {
    return 'open';
  }
  return 'resolved_by_exception';
}

/** The redacted evidence samples of a group, at most five. */
function samplesOf(members: readonly GroupOccurrence[]): readonly EvidenceSample[] {
  return members
    .filter((occurrence) => occurrence.state !== 'fixed')
    .map((occurrence) => ({
      occurrenceKey: occurrence.occurrenceKey,
      subject: occurrence.subject,
      safeLocation: occurrence.safeLocation,
      evidenceHash: occurrence.evidenceHash,
      evidence: occurrence.evidence,
    }))
    .sort(compareSamples)
    .slice(0, MAX_EVIDENCE_SAMPLES);
}

/** The occurrence keys that keep the group from being Fixed. */
function blockersOf(
  unresolvedActive: readonly GroupOccurrence[],
  unresolvedArchived: readonly GroupOccurrence[],
): readonly string[] {
  return [...unresolvedActive, ...unresolvedArchived]
    .map((occurrence) => occurrence.occurrenceKey)
    .sort(compareCodeUnits);
}

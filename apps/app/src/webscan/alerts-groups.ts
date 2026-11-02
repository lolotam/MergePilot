import {
  groupOccurrences,
  type GroupOccurrence,
  type IssueGroup,
  type OccurrenceRecord,
  type RetainedOccurrence,
  type ScanException,
  type Severity,
  type Validation,
} from '@mergepilot/webscan';
import { compareCodeUnits, severityRank, validationRank, type AlertLevel } from './alerts-episodes.js';
import type { AlertThresholds } from './alerts-types.js';
import type { WebScanAlertEpisode, WebScanException } from './types.js';

/**
 * The ledger of a site, as the alert engine reads it (ADR-0052 sections 4, 8
 * and 9).
 *
 * The grouping of the occurrences is the one of the scanner package: it owns
 * the meaning of a group, of a blocker and of a resolution, so the alert engine
 * never decides on its own whether a group is fixed, blocked or resolved by an
 * administrator.
 */

/** The ledger of a site, resolved once per evaluation. */
export interface AlertLedger {
  /** The group of every issue key of the site. */
  groups: Map<string, IssueGroup>;
  /** The live resolution that covers every occurrence of the ledger. */
  exceptionsByOccurrence: Map<string, WebScanException>;
}

/**
 * Builds the ledger of a site.
 *
 * Only the resolutions that are live at the given instant are honoured: a
 * revoked or expired resolution covers nothing, so its finding returns to the
 * normal outstanding state.
 */
export function buildLedger(
  occurrences: readonly RetainedOccurrence[],
  exceptions: readonly WebScanException[],
  nowMs: number,
): AlertLedger {
  const live = exceptions.filter((exception) => isLiveException(exception, nowMs));
  const records = occurrences.map(toOccurrenceRecord);
  const groups = groupOccurrences(records, {
    exceptions: live.map(toScanException),
    now: nowMs,
  });
  return {
    groups: new Map(groups.map((group) => [group.issueKey, group])),
    exceptionsByOccurrence: indexExceptions(records, live),
  };
}

/**
 * The live resolution that covers each occurrence of the ledger.
 *
 * A resolution covers an occurrence only while the occurrence key and the
 * evidence hash both match. The newest resolution wins, so a later decision
 * replaces an earlier one.
 */
function indexExceptions(
  records: readonly OccurrenceRecord[],
  live: readonly WebScanException[],
): Map<string, WebScanException> {
  const evidenceByOccurrence = new Map<string, string>();
  for (const record of records) {
    evidenceByOccurrence.set(record.occurrenceKey, record.evidenceHash);
  }

  const indexed = new Map<string, WebScanException>();
  for (const exception of live) {
    if (evidenceByOccurrence.get(exception.occurrenceKey) !== exception.evidenceHash) {
      continue;
    }
    const known = indexed.get(exception.occurrenceKey);
    if (known === undefined || isNewerException(exception, known)) {
      indexed.set(exception.occurrenceKey, exception);
    }
  }
  return indexed;
}

/** Whether one resolution is newer than another. */
function isNewerException(left: WebScanException, right: WebScanException): boolean {
  const leftTime = left.createdAt.getTime();
  const rightTime = right.createdAt.getTime();
  if (leftTime !== rightTime) {
    return leftTime > rightTime;
  }
  return compareCodeUnits(left.id, right.id) < 0;
}

/**
 * Maps one ledger row onto the record the grouping reads.
 *
 * The alert state is separate from the comparison of a scan, and the ledger
 * rows do not carry a comparison state, so the grouping receives the neutral
 * value of a row that was never compared.
 */
function toOccurrenceRecord(row: RetainedOccurrence): OccurrenceRecord {
  const identity = row.state === 'archived' ? row.identity : row.finding;
  const evidence = row.state === 'archived' ? null : row.finding.evidence;
  return {
    occurrenceKey: identity.occurrenceKey,
    targetKey: identity.targetKey,
    issueKey: identity.issueKey,
    checkId: identity.checkId,
    issueId: identity.issueId,
    subject: identity.subject,
    severity: identity.severity,
    validation: identity.validation,
    confidence: identity.confidence,
    safeLocation: identity.safeLocation,
    evidenceHash: identity.evidenceHash,
    evidence,
    state: row.state,
    comparison: 'Not checked',
  };
}

/** Maps one resolution onto the resolution the grouping reads. */
function toScanException(exception: WebScanException): ScanException {
  return {
    occurrenceKey: exception.occurrenceKey,
    evidenceHash: exception.evidenceHash,
    kind: exception.kind,
    expiresAt: exception.expiresAt === null ? null : exception.expiresAt.getTime(),
  };
}

/** Whether a resolution still applies at the given instant. */
function isLiveException(exception: WebScanException, nowMs: number): boolean {
  if (exception.revokedAt !== null) {
    return false;
  }
  if (exception.expiresAt !== null && exception.expiresAt.getTime() <= nowMs) {
    return false;
  }
  return true;
}

/** Whether one member of a group may open an issue. */
export function isEligible(member: GroupOccurrence, thresholds: AlertThresholds): boolean {
  if (member.state !== 'outstanding') {
    return false;
  }
  if (member.exception !== undefined) {
    return false;
  }
  if (severityRank(member.severity) > severityRank(thresholds.alertMinSeverity)) {
    return false;
  }
  if (validationRank(member.validation) > validationRank(thresholds.alertMinValidation)) {
    return false;
  }
  return true;
}

/** The level of the eligible members of a group. */
export function levelOf(eligible: readonly GroupOccurrence[]): AlertLevel {
  let severity: Severity = 'info';
  let validation: Validation = 'Informational';
  for (const member of eligible) {
    if (severityRank(member.severity) < severityRank(severity)) {
      severity = member.severity;
    }
    if (validationRank(member.validation) < validationRank(validation)) {
      validation = member.validation;
    }
  }
  return { severity, validation };
}

/**
 * The level of an episode that starts now.
 *
 * The level of an issue key never falls: a new episode inherits the strongest
 * level its group ever reached, so a churn of targets that weakens the group
 * cannot open a second issue and a group that grows stronger opens exactly
 * one.
 */
export function highestLevel(current: AlertLevel, previous: AlertLevel | undefined): AlertLevel {
  if (previous === undefined) {
    return current;
  }
  return {
    severity:
      severityRank(current.severity) <= severityRank(previous.severity)
        ? current.severity
        : previous.severity,
    validation:
      validationRank(current.validation) <= validationRank(previous.validation)
        ? current.validation
        : previous.validation,
  };
}

/** The level an episode reached, when it recorded one. */
export function levelOfEpisode(episode: WebScanAlertEpisode): AlertLevel | undefined {
  if (episode.severity === undefined || episode.validation === undefined) {
    return undefined;
  }
  return { severity: episode.severity, validation: episode.validation };
}

/** Whether the eligible members of a group rose above the level of the episode. */
export function levelRose(existing: WebScanAlertEpisode, level: AlertLevel): boolean {
  if (existing.severity === undefined || existing.validation === undefined) {
    return false;
  }
  return (
    severityRank(level.severity) < severityRank(existing.severity) ||
    validationRank(level.validation) < validationRank(existing.validation)
  );
}

/**
 * The resolution of a group.
 *
 * A group is fixed when every member was proven fixed, and it is resolved by
 * an administrator resolution when every unresolved member carries one. A
 * group with an archived member that was never proven fixed is neither: it
 * stays blocked until the coverage proves that exact member or a resolution
 * names it.
 */
export function resolutionOf(
  group: IssueGroup | undefined,
  existing: WebScanAlertEpisode | undefined,
): 'fixed' | 'resolved-by-exception' | undefined {
  if (group === undefined) {
    // Every member of the episode left the ledger, so each of them was proven
    // fixed before it was pruned.
    return existing !== undefined && existing.occurrenceKeys.length > 0 ? 'fixed' : undefined;
  }
  if (group.status === 'fixed') {
    return 'fixed';
  }
  if (group.status === 'resolved_by_exception') {
    return 'resolved-by-exception';
  }
  return undefined;
}

/** The resolution that unblocked a group. */
export function namedException(
  exceptionsByOccurrence: ReadonlyMap<string, WebScanException>,
  members: readonly GroupOccurrence[],
): WebScanException | undefined {
  let found: WebScanException | undefined;
  for (const member of members) {
    const exception = exceptionsByOccurrence.get(member.occurrenceKey);
    if (exception === undefined) {
      continue;
    }
    if (found === undefined || isNewerException(exception, found)) {
      found = exception;
    }
  }
  return found;
}

/** The occurrence keys of a group, ordered. */
export function sortedKeys(members: readonly GroupOccurrence[]): string[] {
  return members.map((member) => member.occurrenceKey).sort(compareCodeUnits);
}

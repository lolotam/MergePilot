import type { WebScanOccurrenceDto } from '@mergepilot/app/contract';
import { SEVERITY_ORDER } from './labels.js';

/**
 * The grouping of the findings of a scan (ADR-0052 section 4).
 *
 * The group is a view and never a change of identity: the occurrences of one
 * issue on one site are shown together, and every member keeps its own
 * validation, its own comparison and its own resolution.
 */

/** The factors of the risk of one group (ADR-0052 section 4). */
export interface RiskFactors {
  /** The base of the severity of the strongest observation. */
  severityBase: number;
  /** The factor of the confidence of that observation. */
  confidence: number;
  /** The factor of the validation of that observation. */
  validation: number;
  /** The factor of the number of affected targets. */
  surface: number;
  /** The distinct targets the surface was computed from. */
  affectedUrls: number;
}

/** One group of findings: the occurrences of one issue. */
export interface FindingsGroup {
  issueKey: string;
  checkId: WebScanOccurrenceDto['checkId'];
  issueId: string;
  subject: string;
  severity: WebScanOccurrenceDto['severity'];
  occurrences: WebScanOccurrenceDto[];
  /** The internal risk score of the group, never a CVSS score. */
  score: number;
  factors: RiskFactors;
}

/** The base of every severity, as ADR-0052 section 4 fixes it. */
const SEVERITY_BASE: Readonly<Record<WebScanOccurrenceDto['severity'], number>> = {
  critical: 10,
  high: 8,
  medium: 5,
  low: 2.5,
  info: 1,
};

/** The factor of every confidence, as ADR-0052 section 4 fixes it. */
const CONFIDENCE_FACTOR: Readonly<Record<WebScanOccurrenceDto['confidence'], number>> = {
  high: 1,
  medium: 0.8,
  low: 0.6,
};

/** The factor of every validation state, as ADR-0052 section 4 fixes it. */
const VALIDATION_FACTOR: Readonly<Record<WebScanOccurrenceDto['validation'], number>> = {
  Confirmed: 1,
  Likely: 0.85,
  Indicator: 0.6,
  Informational: 0.4,
};

/**
 * The factor of the number of affected targets.
 *
 * The surface grows with the number of affected targets and is capped at half
 * a step, so a wide issue does not push the other factors out of the score.
 */
function surfaceFactor(affectedUrls: number): number {
  if (affectedUrls <= 1) return 1;
  return 1 + Math.min(0.5, 0.1 * (affectedUrls - 1));
}

/** The members of a group that count for its active risk. */
function activeOccurrences(occurrences: WebScanOccurrenceDto[]): WebScanOccurrenceDto[] {
  return occurrences.filter(
    (occurrence) => occurrence.state === 'outstanding' && occurrence.exceptionId === null,
  );
}

/** The strongest severity of a list of occurrences. */
function strongestSeverity(occurrences: WebScanOccurrenceDto[]): WebScanOccurrenceDto['severity'] {
  let strongest = occurrences[0]!.severity;
  for (const occurrence of occurrences) {
    if (SEVERITY_ORDER.indexOf(occurrence.severity) < SEVERITY_ORDER.indexOf(strongest)) {
      strongest = occurrence.severity;
    }
  }
  return strongest;
}

/**
 * The risk of a group and its factors.
 *
 * The score is the internal prioritization aid of ADR-0052 section 4, never a
 * CVSS score. The factors come from one observation: the strongest weighted
 * member of the group, so the score never combines the severity of one finding
 * with the confidence of another. Only the members that count for the active
 * risk are used: an archived member has no evidence and a resolved member is
 * out of the risk.
 */
export function assessGroupRisk(occurrences: WebScanOccurrenceDto[]): {
  score: number;
  factors: RiskFactors;
} {
  const active = activeOccurrences(occurrences);
  const affectedUrls = new Set(active.map((occurrence) => occurrence.targetKey)).size;
  const surface = surfaceFactor(affectedUrls);
  if (active.length === 0) {
    return {
      score: 0,
      factors: { severityBase: 0, confidence: 0, validation: 0, surface: 0, affectedUrls: 0 },
    };
  }
  const source = strongestObservation(active);
  const severityBase = SEVERITY_BASE[source.severity];
  const confidence = CONFIDENCE_FACTOR[source.confidence];
  const validation = VALIDATION_FACTOR[source.validation];
  return {
    score: Math.min(10, severityBase * confidence * validation * surface),
    factors: { severityBase, confidence, validation, surface, affectedUrls },
  };
}

/**
 * The observation the factors of a score come from.
 *
 * The strongest weighted member wins, and a tie is broken by the occurrence
 * key, so the choice never depends on the order of the input.
 */
function strongestObservation(occurrences: WebScanOccurrenceDto[]): WebScanOccurrenceDto {
  let strongest = occurrences[0]!;
  for (const occurrence of occurrences) {
    const weight =
      SEVERITY_BASE[occurrence.severity] *
      CONFIDENCE_FACTOR[occurrence.confidence] *
      VALIDATION_FACTOR[occurrence.validation];
    const best =
      SEVERITY_BASE[strongest.severity] *
      CONFIDENCE_FACTOR[strongest.confidence] *
      VALIDATION_FACTOR[strongest.validation];
    if (weight > best || (weight === best && occurrence.occurrenceKey < strongest.occurrenceKey)) {
      strongest = occurrence;
    }
  }
  return strongest;
}

/**
 * The findings of a scan, grouped by issue.
 *
 * The groups are ordered by their issue key and their members by their
 * occurrence key, so the page never depends on the order of the answer.
 */
export function groupOccurrences(occurrences: WebScanOccurrenceDto[]): FindingsGroup[] {
  const grouped = new Map<string, WebScanOccurrenceDto[]>();
  for (const occurrence of occurrences) {
    const group = grouped.get(occurrence.issueKey);
    if (group === undefined) {
      grouped.set(occurrence.issueKey, [occurrence]);
      continue;
    }
    group.push(occurrence);
  }
  return [...grouped.keys()]
    .sort()
    .map((issueKey) => {
      const members = [...(grouped.get(issueKey) ?? [])].sort(byOccurrenceKey);
      const first = members[0]!;
      const risk = assessGroupRisk(members);
      return {
        issueKey,
        checkId: first.checkId,
        issueId: first.issueId,
        subject: first.subject,
        severity: strongestSeverity(members),
        occurrences: members,
        score: risk.score,
        factors: risk.factors,
      };
    });
}

/** The order of the members of a group: by their occurrence key. */
function byOccurrenceKey(left: WebScanOccurrenceDto, right: WebScanOccurrenceDto): number {
  if (left.occurrenceKey === right.occurrenceKey) return 0;
  return left.occurrenceKey < right.occurrenceKey ? -1 : 1;
}

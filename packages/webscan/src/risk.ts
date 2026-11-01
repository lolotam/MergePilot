/**
 * The risk score of a group (ADR-0052 section 4).
 *
 * The score is an internal prioritization aid. It is **not** a CVSS score and
 * it never claims to be one.
 *
 *   risk = min(10, severityBase × confidence × validation × surface)
 *
 * The factors come from one observation. When the members of a group disagree
 * about their confidence or their validation, the factors of the strongest
 * weighted observation are used, so the score never combines the severity of
 * one finding with the confidence of another. The occurrence the factors came
 * from is reported with the score.
 *
 * Only the active members of a group count: an outstanding member without a
 * resolution. An archived member has no evidence, and an excepted member was
 * resolved by the administrator, so neither of them may manufacture a
 * stronger observation or a larger surface.
 */

import { activeOccurrences, type GroupOccurrence, type IssueGroup } from './group.js';
import type { Confidence, Severity, Validation } from './types.js';

/** The base of every severity, as ADR-0052 section 4 fixes it. */
export const SEVERITY_BASE_FACTORS: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 10,
  high: 8,
  medium: 5,
  low: 2.5,
  info: 1,
});

/** The factor of every confidence, as ADR-0052 section 4 fixes it. */
export const CONFIDENCE_FACTORS: Readonly<Record<Confidence, number>> = Object.freeze({
  high: 1,
  medium: 0.8,
  low: 0.6,
});

/** The factor of every validation state, as ADR-0052 section 4 fixes it. */
export const VALIDATION_FACTORS: Readonly<Record<Validation, number>> = Object.freeze({
  Confirmed: 1,
  Likely: 0.85,
  Indicator: 0.6,
  Informational: 0.4,
});

/**
 * The surface factor of a number of affected targets.
 *
 * The surface grows with the number of affected URLs and is capped at half a
 * step, so a wide issue does not push every other factor out of the score.
 */
export function surfaceFactor(affectedUrls: number): number {
  if (affectedUrls <= 1) {
    return 1;
  }
  return 1 + Math.min(0.5, 0.1 * (affectedUrls - 1));
}

/** The factors of one score. */
export interface RiskFactors {
  readonly severityBase: number;
  readonly confidence: number;
  readonly validation: number;
  readonly surface: number;
  /** The distinct targets the surface was computed from. */
  readonly affectedUrls: number;
}

/** The observation the factors of a score came from. */
export interface RiskSource {
  readonly occurrenceKey: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly validation: Validation;
}

/** One risk score with its factors. */
export interface RiskAssessment {
  /** The score of ADR-0052 section 4, capped at ten and never rounded. */
  readonly score: number;
  readonly factors: RiskFactors;
  /** The observation the factors came from, or null for an empty group. */
  readonly source: RiskSource | null;
}

/** The weighted observation of one member, without the surface. */
function weightOf(occurrence: GroupOccurrence): number {
  return (
    SEVERITY_BASE_FACTORS[occurrence.severity] *
    CONFIDENCE_FACTORS[occurrence.confidence] *
    VALIDATION_FACTORS[occurrence.validation]
  );
}

/**
 * The observation whose factors the score uses.
 *
 * The strongest weighted observation wins. A tie is broken by the occurrence
 * key, so the choice never depends on the order of the input.
 */
function strongestObservation(occurrences: readonly GroupOccurrence[]): GroupOccurrence | undefined {
  let strongest: GroupOccurrence | undefined;
  for (const occurrence of occurrences) {
    if (strongest === undefined) {
      strongest = occurrence;
      continue;
    }
    const weight = weightOf(occurrence);
    const best = weightOf(strongest);
    if (weight > best || (weight === best && occurrence.occurrenceKey < strongest.occurrenceKey)) {
      strongest = occurrence;
    }
  }
  return strongest;
}

/** The score of the given factors. */
function scoreOf(
  severityBase: number,
  confidence: number,
  validation: number,
  surface: number,
): number {
  return Math.min(10, severityBase * confidence * validation * surface);
}

/**
 * The risk of a group.
 *
 * An empty group, a group of fixed members and a group whose members are all
 * excepted or archived have no active risk and score zero.
 */
export function assessGroupRisk(group: IssueGroup): RiskAssessment {
  const active = activeOccurrences(group);
  const source = strongestObservation(active);
  if (source === undefined) {
    return {
      score: 0,
      factors: {
        severityBase: 0,
        confidence: 0,
        validation: 0,
        surface: 0,
        affectedUrls: 0,
      },
      source: null,
    };
  }
  const affectedUrls = new Set(active.map((occurrence) => occurrence.targetKey)).size;
  const surface = surfaceFactor(affectedUrls);
  const severityBase = SEVERITY_BASE_FACTORS[source.severity];
  const confidence = CONFIDENCE_FACTORS[source.confidence];
  const validation = VALIDATION_FACTORS[source.validation];
  return {
    score: scoreOf(severityBase, confidence, validation, surface),
    factors: { severityBase, confidence, validation, surface, affectedUrls },
    source: {
      occurrenceKey: source.occurrenceKey,
      severity: source.severity,
      confidence: source.confidence,
      validation: source.validation,
    },
  };
}

/**
 * The risk of one occurrence, with the surface of its group.
 *
 * The factors are the ones of the occurrence itself. The caller decides
 * whether the occurrence counts: an archived or an excepted occurrence is not
 * part of the active risk of the site.
 */
export function assessOccurrenceRisk(
  occurrence: GroupOccurrence,
  affectedUrls: number,
): RiskAssessment {
  const surface = surfaceFactor(affectedUrls);
  const severityBase = SEVERITY_BASE_FACTORS[occurrence.severity];
  const confidence = CONFIDENCE_FACTORS[occurrence.confidence];
  const validation = VALIDATION_FACTORS[occurrence.validation];
  return {
    score: scoreOf(severityBase, confidence, validation, surface),
    factors: { severityBase, confidence, validation, surface, affectedUrls },
    source: {
      occurrenceKey: occurrence.occurrenceKey,
      severity: occurrence.severity,
      confidence: occurrence.confidence,
      validation: occurrence.validation,
    },
  };
}

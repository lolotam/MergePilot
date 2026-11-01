/**
 * The check-evaluation seam (ADR-0052 section 3).
 *
 * The transport, the crawler and the six catalogue checks live behind this
 * module. The run collects the pages it received and hands them to an
 * evaluator, which returns the coverage it was able to establish and the
 * findings it proved.
 *
 * An evaluator publishes its results through `emit` while it works, so a
 * check that already proved something keeps its result when a later request
 * fails or the scan stops.
 *
 * The context of an evaluation carries everything a check needs and nothing it
 * may not have:
 *
 * - The pages that were read, with their transient metadata. A check needs
 *   the URL of a baseline and the `Location` of a redirect it did not follow.
 *   They stay inside the package: a raw URL never reaches a result.
 * - A request capability. The requests of a check spend the budget of the
 *   scan and obey the deadline and the policy of the scan.
 * - The identity functions of the app, so a check can name an occurrence of an
 *   issue on a target it probed itself.
 * - The authorized parameterized links the crawl found, bounded by the active
 *   budget of the scan.
 */

import type { ScanCandidate } from './candidates.js';
import type { ScanCheckRequester } from './check-requests.js';
import type { ScanTargetKind } from './client.js';
import type {
  CheckId,
  CheckSwitches,
  CoverageEntry,
  OccurrenceFinding,
  ScanLimits,
  ScanScope,
} from './types.js';

/** The six catalogue checks, in their catalogue order. */
export const CHECK_IDS: readonly CheckId[] = Object.freeze([
  'headers',
  'cookies',
  'transport',
  'disclosure',
  'files',
  'active',
]);

/**
 * The version a coverage row carries when the check never ran.
 *
 * A check version records which implementation produced a result. A target
 * that could not be read has no such implementation, so the row carries this
 * value and never a `checked` outcome.
 */
export const UNVERSIONED_CHECK_VERSION = 0;

/** One target, as a check needs it. */
export interface CheckTarget {
  /** The identity of the baseline target. */
  readonly targetKey: string;
  /**
   * The URL of the baseline target.
   *
   * Transient: it never leaves the package. A check needs it to name a file
   * path next to a crawled script and to compare a baseline with a probe.
   */
  readonly baselineUrl: string;
  /** The URL the redirect chain ended at. Transient, like the baseline URL. */
  readonly finalUrl: string;
  /**
   * The `Location` of a redirect that was not followed.
   *
   * Transient. It tells a check whether a redirect proves that a file is not
   * served at the probed path.
   */
  readonly location: string | null;
  /** How the target was requested. */
  readonly kind: ScanTargetKind;
  readonly status: number;
  /** The response headers. A check reads only what its catalogue allows. */
  readonly headers: Headers;
  /** The bounded body. Empty when the destination was not reached. */
  readonly body: Uint8Array;
  /** Whether the body of the requested destination was reached. */
  readonly destinationReached: boolean;
}

/** What one check established for one target. */
export interface CheckEvaluation {
  /** The coverage row this evaluation produced. */
  readonly coverage: CoverageEntry;
  /** The findings this evaluation proved. */
  readonly findings: readonly OccurrenceFinding[];
}

/** The identity functions the app injects into the scan. */
export interface ScanIdentityFunctions {
  /** The identity of the original baseline URL, never of a mutated probe. */
  readonly identifyTarget: (baselineUrl: string) => string;
  /** The identity of one occurrence of a check issue on a target. */
  readonly identifyOccurrence: (input: {
    targetKey: string;
    checkId: CheckId;
    issueId: string;
    subject: string;
  }) => string;
}

/** The context one evaluation runs in. */
export interface CheckEvaluationContext {
  readonly scope: ScanScope;
  readonly limits: ScanLimits;
  /** The targets that were read. */
  readonly targets: readonly CheckTarget[];
  /** The identities of the targets that could not be read. */
  readonly unreadableTargetKeys: readonly string[];
  /**
   * The requests a check may make.
   *
   * They share the budget, the pacing and the deadline of the scan, and every
   * one of them is checked again by the client of the scan.
   */
  readonly request: ScanCheckRequester;
  /** The identity functions of the app. */
  readonly identity: ScanIdentityFunctions;
  /**
   * The authorized parameterized links the crawl found.
   *
   * They are bounded by the active budget of the scan. Two links that differ
   * only in a query value are two candidates.
   */
  readonly candidates: readonly ScanCandidate[];
  /**
   * The per-check switches of this scan.
   *
   * A check that is switched off evaluates nothing. It may report that it did
   * not run, but it must never claim an issue id.
   */
  readonly checks: CheckSwitches;
  /**
   * Publishes the evaluations an evaluator has finished so far.
   *
   * The run collects them immediately, so the findings and the coverage a
   * check already proved survive a later failure or stop. An evaluator that
   * emits an evaluation and returns it as well keeps one copy of it: the run
   * drops the second one.
   */
  readonly emit: (evaluations: readonly CheckEvaluation[]) => void;
}

/** The pluggable check layer. */
export interface CheckEvaluator {
  readonly evaluate: (context: CheckEvaluationContext) => Promise<readonly CheckEvaluation[]>;
}

/** The evaluator used while no check is implemented. */
export const NO_CHECK_EVALUATOR: CheckEvaluator = Object.freeze({
  evaluate: async () => [],
});

/**
 * The coverage reason for a target that could not be read.
 *
 * The port-80 probe has its own reason: its outcome is check-scoped, so a
 * closed or unreachable cleartext port never fails the scan. Every other
 * target is an ordinary target error.
 */
export function coverageReasonForTargetError(kind: ScanTargetKind): 'http_probe_unreachable' | 'target_error' {
  return kind === 'transport-probe' ? 'http_probe_unreachable' : 'target_error';
}

/**
 * The scan run (ADR-0052 section 7).
 *
 * `runScan` is the pure entry point of the package. It owns the order of the
 * scan — crawl, then check — and it owns the counters, the terminal status and
 * the coverage ledger. It owns nothing else: the transport is injected, the
 * clock is injected, the identity functions are injected and the checks are
 * plugged in through the evaluator seam.
 *
 * The result carries only safe data. The raw URLs, the raw query values, the
 * response bodies and the transport error texts never reach it, because the
 * app persists the result and the dashboard renders it.
 */

import { createCheckRequester } from './check-requests.js';
import { ScanClient } from './client.js';
import { CATALOGUE_CHECK_EVALUATOR } from './checks/evaluator.js';
import { crawlSite, type CrawlResult } from './crawl.js';
import {
  ScanPolicyError,
  ScanStopError,
  ScanTransportError,
} from './errors.js';
import {
  CHECK_IDS,
  UNVERSIONED_CHECK_VERSION,
  coverageReasonForTargetError,
  type CheckEvaluation,
  type CheckEvaluator,
  type CheckTarget,
} from './evaluation.js';
import { validateScanContact } from './user-agent.js';
import type {
  CheckId,
  CoverageEntry,
  CoverageSubjectScope,
  OccurrenceFinding,
  ScanDependencies,
  ScanFailureReason,
  ScanInput,
  ScanObservation,
  ScanStopReason,
} from './types.js';

/** An empty crawl result, used when the crawl could not start at all. */
function emptyCrawl(): CrawlResult {
  return {
    pages: [],
    errors: [],
    discovered: 0,
    pageCapReached: false,
    linkCapReached: false,
    candidateCapReached: false,
    candidates: [],
    baseTargetFailed: false,
    stopped: undefined,
  };
}

/** The targets a check may look at. */
function checkTargets(crawl: CrawlResult): CheckTarget[] {
  return crawl.pages.map((page) => ({
    targetKey: page.targetKey,
    baselineUrl: page.url,
    finalUrl: page.finalUrl,
    location: page.location,
    kind: page.kind,
    status: page.status,
    headers: page.headers,
    body: page.body,
    destinationReached: page.destinationReached,
  }));
}

/**
 * The coverage rows of the targets that could not be read.
 *
 * A target that failed at the transport level could not be evaluated by any
 * check, so every enabled check records an error row for it. The absence of a
 * row would say the same thing, but an explicit row keeps the reason.
 */
function unreadableCoverage(crawl: CrawlResult, enabled: readonly CheckId[]): CoverageEntry[] {
  const rows: CoverageEntry[] = [];
  for (const error of crawl.errors) {
    for (const checkId of enabled) {
      rows.push({
        targetKey: error.targetKey,
        checkId,
        checkVersion: UNVERSIONED_CHECK_VERSION,
        evaluatedIssueIds: [],
        outcome: 'error',
        reason: coverageReasonForTargetError(error.kind),
      });
    }
  }
  return rows;
}

/**
 * Whether the scan covered everything it was asked to cover.
 *
 * A scan is partial when the page cap truncated the crawl, when the bounded
 * plan of the crawler had to drop links, when a target could not be read, or
 * when an enabled check did not evaluate a visited target. A scan that stopped
 * or failed is always partial: it is never a completed baseline.
 */
function isPartialCoverage(
  input: ScanInput,
  crawl: CrawlResult,
  evaluations: readonly CheckEvaluation[],
): boolean {
  if (
    crawl.pages.length === 0 ||
    crawl.pageCapReached ||
    crawl.linkCapReached ||
    crawl.candidateCapReached ||
    crawl.errors.length > 0
  ) {
    return true;
  }
  const enabled = CHECK_IDS.filter((checkId) => input.checks[checkId]);
  if (enabled.length === 0) {
    return false;
  }
  if (evaluations.some(({ coverage }) => input.checks[coverage.checkId] && coverage.outcome !== 'checked')) {
    return true;
  }
  const evaluated = new Set(
    evaluations.map((evaluation) => `${evaluation.coverage.targetKey}|${evaluation.coverage.checkId}`),
  );
  for (const page of crawl.pages) {
    for (const checkId of enabled) {
      if (!evaluated.has(`${page.targetKey}|${checkId}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The group of one coverage row.
 *
 * Two evaluations of the same target, the same check and the same subject scope
 * describe one coverage fact, so they are merged into one row. The subject
 * scope belongs to the group: two scopes are two facts, and they must never
 * collapse into one another.
 */
function evaluationGroup(evaluation: CheckEvaluation): string {
  const coverage = evaluation.coverage;
  return [
    coverage.targetKey,
    coverage.checkId,
    encodeSubjectScope(coverage.subjectScope),
  ].join('|');
}

/**
 * Encodes the subject scope of a coverage row.
 *
 * The encoding is unambiguous: every name carries its length, so two different
 * scopes can never produce the same encoded scope.
 */
function encodeSubjectScope(scope: CoverageSubjectScope | undefined): string {
  if (scope === undefined) {
    return 'absent';
  }
  if (scope.kind === 'complete') {
    return 'complete';
  }
  return `restricted:${scope.subjects.map((subject) => `${subject.length}:${subject}`).join('')}`;
}

/**
 * Merges two evaluations of one coverage group.
 *
 * The evaluated issue ids are the union of the evaluated ones, the outcome is
 * the least complete one of the two, and the findings are the union by
 * occurrence key, so a finding that both evaluations carry is kept once.
 */
function mergeEvaluation(first: CheckEvaluation, second: CheckEvaluation): CheckEvaluation {
  const evaluatedIssueIds = [
    ...new Set([...first.coverage.evaluatedIssueIds, ...second.coverage.evaluatedIssueIds]),
  ];
  const outcome = first.coverage.outcome === 'checked' ? second.coverage.outcome : first.coverage.outcome;
  const reason = outcome === 'checked' ? undefined : first.coverage.reason ?? second.coverage.reason;
  const known = new Set(first.findings.map((finding) => finding.occurrenceKey));
  const findings = [
    ...first.findings,
    ...second.findings.filter((finding) => !known.has(finding.occurrenceKey)),
  ];
  const base: CoverageEntry = {
    targetKey: first.coverage.targetKey,
    checkId: first.coverage.checkId,
    checkVersion: first.coverage.checkVersion,
    evaluatedIssueIds,
    outcome,
  };
  const scoped: CoverageEntry =
    first.coverage.subjectScope === undefined
      ? base
      : { ...base, subjectScope: first.coverage.subjectScope };
  return reason === undefined
    ? { coverage: scoped, findings }
    : { coverage: { ...scoped, reason }, findings };
}

/**
 * Merges the evaluations an evaluator emitted and returned.
 *
 * An evaluator that emits its evaluations and returns them as well would
 * double them, so the run keeps one row per group.
 */
function mergeEvaluations(
  batches: readonly (readonly CheckEvaluation[])[],
): readonly CheckEvaluation[] {
  const merged: CheckEvaluation[] = [];
  const groups = new Map<string, number>();
  for (const batch of batches) {
    for (const evaluation of batch) {
      const group = evaluationGroup(evaluation);
      const position = groups.get(group);
      if (position === undefined) {
        groups.set(group, merged.length);
        merged.push(evaluation);
        continue;
      }
      merged[position] = mergeEvaluation(merged[position]!, evaluation);
    }
  }
  return merged;
}

/**
 * The stop an error of the crawl or of a check means.
 *
 * A typed stop ends the scan without failing it. The reason survives, so a
 * lost lease or a closed kill switch stays what it was.
 */
function stopOf(error: unknown): ScanStopReason | undefined {
  return error instanceof ScanStopError ? error.reason : undefined;
}

/**
 * The failure an error of the crawl or of a check means.
 *
 * A refused request fails the scan, a transport failure fails it too, and
 * anything else is an ordinary error of one target.
 */
function failureOf(error: unknown): ScanFailureReason {
  if (error instanceof ScanPolicyError) {
    return 'policy_violation';
  }
  if (error instanceof ScanTransportError) {
    return 'transport_error';
  }
  return 'target_error';
}

/**
 * Runs one scan.
 *
 * The scan stops on a cancellation, a deadline, an exhausted request budget
 * or a site that rate limits; it fails on a scope violation or on a transport
 * failure that left the scan without a subject. Everything else is a
 * completed scan, possibly with partial coverage.
 *
 * The six catalogue checks run as part of the scan. A check that is switched
 * off evaluates nothing.
 */
export async function runScan(
  input: ScanInput,
  deps: ScanDependencies,
): Promise<ScanObservation> {
  return runScanWithEvaluator(input, deps, CATALOGUE_CHECK_EVALUATOR);
}

/**
 * Runs one scan with an explicit check evaluator.
 *
 * The evaluator is the extension boundary of the checks: the run hands it the
 * pages it read and the request capability, and it collects the evaluations it
 * emits and returns.
 */
export async function runScanWithEvaluator(
  input: ScanInput,
  deps: ScanDependencies,
  evaluator: CheckEvaluator,
): Promise<ScanObservation> {
  const startedAt = deps.now();
  try {
    validateScanContact(input.contact);
  } catch {
    // The contact ends up in the User-Agent of every request, so a contact
    // that cannot be used as a header fails the scan before it sends
    // anything.
    return {
      status: 'failed',
      reason: 'policy_violation',
      partialCoverage: true,
      requests: 0,
      pages: 0,
      durationMs: 0,
      findings: [],
      coverage: [],
    };
  }
  const client = new ScanClient(input, deps);
  const findings: OccurrenceFinding[] = [];
  const coverage: CoverageEntry[] = [];
  let stopReason: ScanStopReason | undefined;
  let failureReason: ScanFailureReason | undefined;

  let crawl: CrawlResult;
  try {
    crawl = await crawlSite({
      client,
      scope: input.scope,
      limits: input.limits,
      identifyTarget: deps.identifyTarget,
      onPage: (pages, requests) => {
        deps.onProgress({
          requests,
          pages,
          elapsedMs: deps.now() - startedAt,
          phase: 'crawl',
        });
      },
    });
  } catch (error) {
    crawl = emptyCrawl();
    const stopped = stopOf(error);
    if (stopped !== undefined) {
      stopReason = stopped;
    } else {
      failureReason = failureOf(error);
    }
  }

  if (crawl.stopped !== undefined) {
    stopReason = crawl.stopped;
  } else if (crawl.baseTargetFailed) {
    // The site itself could not be read, so the scan has no subject at all.
    failureReason = 'transport_error';
  }

  const enabled = CHECK_IDS.filter((checkId) => input.checks[checkId]);
  const emitted: CheckEvaluation[] = [];
  let returned: readonly CheckEvaluation[] = [];
  if (failureReason === undefined) {
    // A stopped scan still evaluates the pages it did read, so the operator
    // sees the findings it observed. The scan is not a baseline, and that is
    // the app's comparison to decide, not this package's.
    deps.onProgress({
      requests: client.requestCount,
      pages: crawl.pages.length,
      elapsedMs: deps.now() - startedAt,
      phase: 'checks',
    });
    try {
      returned = await evaluator.evaluate({
        scope: input.scope,
        limits: input.limits,
        targets: checkTargets(crawl),
        unreadableTargetKeys: crawl.errors.map((error) => error.targetKey),
        request: createCheckRequester(client, input.scope),
        identity: {
          identifyTarget: deps.identifyTarget,
          identifyOccurrence: deps.identifyOccurrence,
        },
        candidates: crawl.candidates,
        checks: input.checks,
        emit: (batch) => {
          // The evaluations a check already finished are collected right away,
          // so a later failure does not throw them away.
          emitted.push(...batch);
        },
      });
    } catch (error) {
      // A typed stop during the checks stops the scan; it does not turn the
      // pages that were read into an error of one target.
      const stopped = stopOf(error);
      if (stopped !== undefined) {
        stopReason = stopped;
      } else {
        failureReason = failureOf(error);
      }
    }
  }

  const evaluations = mergeEvaluations([emitted, returned]);
  for (const evaluation of evaluations) {
    coverage.push(evaluation.coverage);
    findings.push(...evaluation.findings);
  }
  coverage.push(...unreadableCoverage(crawl, enabled));

  const partialCoverage =
    stopReason !== undefined ||
    failureReason !== undefined ||
    isPartialCoverage(input, crawl, evaluations);
  const data = {
    partialCoverage,
    requests: client.requestCount,
    pages: crawl.pages.length,
    durationMs: deps.now() - startedAt,
    findings,
    coverage,
  };

  if (stopReason !== undefined) {
    return { ...data, status: 'stopped', reason: stopReason };
  }
  if (failureReason !== undefined) {
    return { ...data, status: 'failed', reason: failureReason };
  }
  deps.onProgress({
    requests: client.requestCount,
    pages: crawl.pages.length,
    elapsedMs: deps.now() - startedAt,
    phase: 'complete',
  });
  return { ...data, status: 'completed' };
}

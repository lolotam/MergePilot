/**
 * The active check (ADR-0052 section 3, check 6).
 *
 * The check is opt-in: it runs on a link only when the administrator named
 * that exact path and its parameter names in the active paths of the site. The
 * opt-in is checked before the baseline is requested, so an unauthorized link
 * is never touched.
 *
 * One selected link costs three requests: the baseline, one apostrophe SQL
 * indicator and one inert reflection marker. The probes only change the value
 * of a parameter that already exists; they never add a parameter, never change
 * the path, the host or the port, and they never submit a form or run a
 * script.
 *
 * A SQL error that the baseline already showed is not attributed to the probe.
 * A reflected marker is always an indicator, never a confirmed exploit.
 *
 * The probes only mean something when the baseline is a usable page of the link
 * and the probe answers with a usable page itself. A denied destination, a
 * refusal, a server error and a transport error never establish the absence of
 * an indicator, so they never let the check claim an issue as evaluated. A
 * database error or a reflected marker in the answer of the server is still an
 * observation of the probed parameter, so it is reported even when the negative
 * coverage is not available.
 */

import { isScanTransportError } from '../errors.js';
import type { CheckEvaluation, CheckEvaluationContext } from '../evaluation.js';
import type { ScanCandidate } from '../candidates.js';
import type { ScanClientResponse } from '../client.js';
import { canonicalTargetDescription } from '../identity.js';
import { activeProbeParameterNames, isActiveProbeAuthorized } from '../scope.js';
import type { CoverageEntry, CoverageSubjectScope, OccurrenceFinding } from '../types.js';
import { parseCanonicalUrl } from '../urls.js';
import { SQL_SIGNATURE_NAMES, type ReflectionForm } from './catalogue.js';
import { buildFinding, coverageRow, decodeBody, safeLocationOf } from './shared.js';

/** The inert marker of the reflection probe. It is not executable. */
const REFLECTION_MARKER = 'mpws reflect 7q';

/** The SQL indicator of the probe. */
const SQL_INDICATOR = "'";

/** The issue of the database error probe. */
const SQL_ISSUE_ID = 'sql-error-indicator';

/** The issue of the reflection probe. */
const REFLECTION_ISSUE_ID = 'reflection-indicator';

/** One signature of a database error. */
interface SqlSignature {
  readonly id: string;
  readonly pattern: RegExp;
}

/** The bounded signatures of a database error. */
const SQL_SIGNATURES: readonly SqlSignature[] = [
  { id: SQL_SIGNATURE_NAMES.syntax, pattern: /you have an error in your sql syntax/i },
  {
    id: SQL_SIGNATURE_NAMES.mysql,
    pattern: /warning:\s*mysql|mysqli_sql_exception|com\.mysql\.jdbc/i,
  },
  {
    id: SQL_SIGNATURE_NAMES.postgres,
    pattern: /pg_query\(\)|pg_syntaxerror|postgresql[^.\n]{0,40}\berror\b/i,
  },
  { id: SQL_SIGNATURE_NAMES.sqlite, pattern: /sqlite3?\.operationalerror|sqlite\/jdbcdriver/i },
  { id: SQL_SIGNATURE_NAMES.unclosedQuote, pattern: /unclosed quotation mark/i },
  { id: SQL_SIGNATURE_NAMES.oracle, pattern: /\bORA-\d{5}\b/ },
];

/** The database error signatures a body shows. */
function sqlSignaturesIn(body: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const signature of SQL_SIGNATURES) {
    if (signature.pattern.test(body)) {
      found.add(signature.id);
    }
  }
  return found;
}

/**
 * The form a reflected marker takes.
 *
 * A marker that comes back encoded, cut short or inside an attribute is still
 * only an indicator.
 */
function detectReflection(body: string): ReflectionForm | null {
  const lowered = body.toLowerCase();
  if (/=["'][^"']*mpws[^"']*["']/i.test(body)) {
    return 'attribute';
  }
  if (lowered.includes(REFLECTION_MARKER)) {
    return 'full';
  }
  if (lowered.includes('mpws+reflect+7q') || lowered.includes('mpws%20reflect%207q')) {
    return 'encoded';
  }
  for (let length = REFLECTION_MARKER.length; length >= 8; length -= 1) {
    if (lowered.includes(REFLECTION_MARKER.slice(0, length))) {
      return 'partial';
    }
  }
  return null;
}

/**
 * Whether a response is the normal page the request asked for.
 *
 * Only such an answer establishes the absence of an indicator: the request
 * reached the destination and the server answered with a success.
 */
function isNormalPage(response: ScanClientResponse): boolean {
  return response.destinationReached && response.status >= 200 && response.status < 300;
}

/**
 * Whether a response may carry an observation of the probed parameter.
 *
 * The body of a denied destination and the body of a refusal belong to another
 * page, so they are never attributed to the link. The body of a server error
 * is the answer of the server to the probe, so a database error or a
 * reflected marker in it is a real observation.
 */
function mayCarryObservation(response: ScanClientResponse): boolean {
  if (!response.destinationReached) {
    return false;
  }
  return (response.status >= 200 && response.status < 300) || response.status >= 500;
}

/** An answer that cannot establish the absence of an indicator. */
interface Unavailable {
  readonly outcome: CoverageEntry['outcome'];
  readonly reason: CoverageEntry['reason'] | undefined;
}

/**
 * The coverage outcome of an answer that cannot establish the absence of an
 * indicator.
 */
function unavailableOutcome(response: ScanClientResponse): Unavailable {
  if (!response.destinationReached) {
    return { outcome: 'not-visited', reason: 'redirect_out_of_scope' };
  }
  if (response.status >= 500) {
    return { outcome: 'error', reason: 'target_error' };
  }
  return { outcome: 'not-visited', reason: 'not_visited' };
}

/** The probe URL of a parameter with a changed value. */
function probeUrl(candidate: ScanCandidate, parameter: string, suffix: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return null;
  }
  const pairs = [...url.searchParams.entries()];
  const index = pairs.findIndex(([name]) => name === parameter);
  const selected = index === -1 ? undefined : pairs[index];
  if (selected === undefined) {
    return null;
  }
  pairs[index] = [selected[0], `${selected[1]}${suffix}`];
  url.search = new URLSearchParams(pairs).toString();
  return url.href;
}

/** One link the active check probes. */
interface SelectedLink {
  readonly candidate: ScanCandidate;
  /**
   * The parameter the probes change.
   *
   * The parameter is chosen from the sorted authorized names of the link, so
   * the order of the query never decides which subject is probed.
   */
  readonly parameter: string;
}

/**
 * The candidates the administrator opted in, bounded by the active budget.
 *
 * Two links that differ only in the order of their query names are one
 * canonical target, so only the first of them is probed: the second would send
 * the same requests and produce the same occurrence again.
 */
function selectedCandidates(context: CheckEvaluationContext): readonly SelectedLink[] {
  const selected: SelectedLink[] = [];
  const seenTargets = new Set<string>();
  for (const candidate of context.candidates) {
    if (selected.length >= context.limits.maxActiveLinks) {
      break;
    }
    let canonical;
    try {
      canonical = parseCanonicalUrl(candidate.url);
    } catch {
      continue;
    }
    if (!isActiveProbeAuthorized(context.scope, canonical)) {
      continue;
    }
    const parameter = activeProbeParameterNames(context.scope, canonical)[0];
    if (parameter === undefined) {
      continue;
    }
    const description = canonicalTargetDescription(canonical);
    if (seenTargets.has(description)) {
      continue;
    }
    seenTargets.add(description);
    selected.push({ candidate, parameter });
  }
  return selected;
}

/**
 * The active check of one scan.
 *
 * Every link that was not opted in is left alone: no baseline, no probe.
 */
export async function evaluateActive(
  context: CheckEvaluationContext,
): Promise<readonly CheckEvaluation[]> {
  const results: CheckEvaluation[] = [];
  for (const target of context.targets) {
    // The active issues belong to the links, not to the pages. The row records
    // that the check ran for the page and evaluated no issue of its own there.
    const page: CheckEvaluation = {
      coverage: coverageRow({
        targetKey: target.targetKey,
        checkId: 'active',
        evaluatedIssueIds: [],
        outcome: 'checked',
        reason: undefined,
      }),
      findings: [],
    };
    results.push(page);
    // The page is published at once, so a link that stops the scan does not
    // take it away.
    context.emit([page]);
  }
  for (const link of selectedCandidates(context)) {
    const result = await evaluateCandidate(context, link);
    results.push(result);
    // Publish the completed link before the next one can hit a terminal guard,
    // including reflection findings that the earlier SQL emission did not carry.
    context.emit([result]);
  }
  return results;
}

/** The baseline of a link, or the reason it cannot be used. */
type BaselineOutcome =
  | { readonly kind: 'baseline'; readonly baseline: ScanClientResponse }
  | { readonly kind: 'unavailable'; readonly unavailable: Unavailable };

/**
 * The baseline of a link.
 *
 * Only a normal page of the link is a usable baseline: a probe answered
 * against a denied destination or a refusal would not say anything about the
 * parameter, so no probe is sent in that case.
 */
async function usableBaseline(
  context: CheckEvaluationContext,
  candidate: ScanCandidate,
): Promise<BaselineOutcome> {
  let baseline: ScanClientResponse;
  try {
    baseline = await context.request.getBaseline(candidate);
  } catch (error) {
    if (!isScanTransportError(error)) {
      throw error;
    }
    return { kind: 'unavailable', unavailable: { outcome: 'error', reason: 'target_error' } };
  }
  if (!isNormalPage(baseline)) {
    return { kind: 'unavailable', unavailable: unavailableOutcome(baseline) };
  }
  return { kind: 'baseline', baseline };
}

/**
 * Evaluates one opted-in link.
 *
 * The row of the link is published in two steps: the proven SQL observation
 * goes out before the reflection probe starts, so a probe that hits the request
 * cap, the deadline or the cancellation keeps what was already proven.
 */
async function evaluateCandidate(
  context: CheckEvaluationContext,
  link: SelectedLink,
): Promise<CheckEvaluation> {
  const { candidate, parameter } = link;
  const targetKey = candidate.targetKey;
  const subjectScope = restrictedScope(parameter);
  const usable = await usableBaseline(context, candidate);
  if (usable.kind === 'unavailable') {
    return unavailableRow(targetKey, subjectScope, usable.unavailable);
  }
  const safeLocation = safeLocationOf(context, candidate.url);
  const sql = await probeSqlIndicator({
    context,
    candidate,
    parameter,
    safeLocation,
    baselineSignatures: sqlSignaturesIn(decodeBody(usable.baseline.body)),
  });
  // The proven SQL observation is published before the next request, so a probe
  // that stops the scan never takes it away.
  context.emit([sqlCoverageRow(targetKey, subjectScope, sql)]);
  const reflection = await probeReflection({ context, candidate, parameter, safeLocation });
  return linkCoverageRow(targetKey, subjectScope, sql, reflection);
}

/**
 * The subjects of the coverage of one link.
 *
 * The active check evaluates one parameter of the link, so its coverage is
 * restricted to that subject. The name is the name of the parameter, never its
 * value, so no query secret reaches a coverage row.
 */
function restrictedScope(parameter: string): CoverageSubjectScope {
  return { kind: 'restricted', subjects: [parameter] };
}

/** The row of a link the check could not evaluate. */
function unavailableRow(
  targetKey: string,
  subjectScope: CoverageSubjectScope,
  unavailable: Unavailable,
): CheckEvaluation {
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'active',
      evaluatedIssueIds: [],
      outcome: unavailable.outcome,
      reason: unavailable.reason,
      subjectScope,
    }),
    findings: [],
  };
}

/** The row of the SQL probe of a link, before the reflection probe runs. */
function sqlCoverageRow(
  targetKey: string,
  subjectScope: CoverageSubjectScope,
  sql: ProbeOutcome,
): CheckEvaluation {
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'active',
      evaluatedIssueIds: sql.conclusive ? [SQL_ISSUE_ID] : [],
      outcome: sql.outcome,
      reason: sql.reason,
      subjectScope,
    }),
    findings: sql.findings,
  };
}

/** The row of a link after both probes of it ran. */
function linkCoverageRow(
  targetKey: string,
  subjectScope: CoverageSubjectScope,
  sql: ProbeOutcome,
  reflection: ProbeOutcome,
): CheckEvaluation {
  const evaluatedIssueIds: string[] = [];
  if (sql.conclusive) {
    evaluatedIssueIds.push(SQL_ISSUE_ID);
  }
  if (reflection.conclusive) {
    evaluatedIssueIds.push(REFLECTION_ISSUE_ID);
  }
  return {
    coverage: coverageRow({
      targetKey,
      checkId: 'active',
      evaluatedIssueIds,
      outcome: worstOutcome(sql, reflection),
      reason: worstReason(sql, reflection),
      subjectScope,
    }),
    findings: [...sql.findings, ...reflection.findings],
  };
}

/** The outcome of one probe. */
interface ProbeOutcome {
  /**
   * Whether the probe answered with the normal page of the probed parameter.
   *
   * Only such an answer establishes the absence of the indicator, so only it
   * lets the check claim the issue as evaluated.
   */
  readonly conclusive: boolean;
  /** The coverage outcome of the probe. */
  readonly outcome: CoverageEntry['outcome'];
  /** The reason of the outcome, when it is not a checked one. */
  readonly reason: CoverageEntry['reason'] | undefined;
  /** The observations the probe made. */
  readonly findings: readonly OccurrenceFinding[];
}

/** The least complete outcome of two probes. */
function worstOutcome(first: ProbeOutcome, second: ProbeOutcome): CoverageEntry['outcome'] {
  if (first.outcome !== 'checked') {
    return first.outcome;
  }
  return second.outcome;
}

/** The reason of the least complete outcome of two probes. */
function worstReason(
  first: ProbeOutcome,
  second: ProbeOutcome,
): CoverageEntry['reason'] | undefined {
  return worstOutcome(first, second) === 'checked' ? undefined : first.reason ?? second.reason;
}

/** What a probe of one parameter of a link needs. */
interface ProbeInput {
  readonly context: CheckEvaluationContext;
  readonly candidate: ScanCandidate;
  readonly parameter: string;
  readonly safeLocation: string;
}

/** What the SQL probe of one parameter of a link needs. */
interface SqlProbeInput extends ProbeInput {
  /** The database errors the baseline already showed. */
  readonly baselineSignatures: ReadonlySet<string>;
}

/**
 * The SQL indicator probe of one link.
 *
 * A database error that the baseline already showed is not attributed to the
 * probe, so the probe only reports the signatures the baseline did not show.
 */
async function probeSqlIndicator(input: SqlProbeInput): Promise<ProbeOutcome> {
  const probe = probeUrl(input.candidate, input.parameter, SQL_INDICATOR);
  if (probe === null) {
    return { conclusive: false, outcome: 'not-visited', reason: 'not_visited', findings: [] };
  }
  let response: ScanClientResponse;
  try {
    response = await input.context.request.probeActive(input.candidate, probe);
  } catch (error) {
    if (!isScanTransportError(error)) {
      throw error;
    }
    // The probe did not answer: the issue stays unchecked.
    return { conclusive: false, outcome: 'error', reason: 'target_error', findings: [] };
  }
  const findings = mayCarryObservation(response)
    ? sqlObservation(input, decodeBody(response.body))
    : [];
  if (isNormalPage(response)) {
    return { conclusive: true, outcome: 'checked', reason: undefined, findings };
  }
  // The answer was not a normal page, so the absence of the indicator is not
  // established. A database error the server answered with is still reported.
  return { conclusive: false, ...unavailableOutcome(response), findings };
}

/**
 * The database error one probe observed.
 *
 * The first signature of the catalogue that the baseline did not show is the
 * evidence of the occurrence, so the evidence of one occurrence stays stable.
 */
function sqlObservation(
  input: SqlProbeInput,
  body: string,
): readonly OccurrenceFinding[] {
  for (const signature of sqlSignaturesIn(body)) {
    if (input.baselineSignatures.has(signature)) {
      continue;
    }
    return [
      buildFinding({
        context: input.context,
        targetKey: input.candidate.targetKey,
        checkId: 'active',
        issueId: SQL_ISSUE_ID,
        subject: input.parameter,
        safeLocation: input.safeLocation,
        validation: 'Likely',
        confidence: 'medium',
        evidence: { parameter: input.parameter, signature },
      }),
    ];
  }
  return [];
}

/**
 * The reflection probe of one link.
 *
 * The marker is inert, so a reflection is only ever an indicator. The marker
 * itself never reaches the finding.
 */
async function probeReflection(input: ProbeInput): Promise<ProbeOutcome> {
  const probe = probeUrl(input.candidate, input.parameter, REFLECTION_MARKER);
  if (probe === null) {
    return { conclusive: false, outcome: 'not-visited', reason: 'not_visited', findings: [] };
  }
  let response: ScanClientResponse;
  try {
    response = await input.context.request.probeActive(input.candidate, probe);
  } catch (error) {
    if (!isScanTransportError(error)) {
      throw error;
    }
    return { conclusive: false, outcome: 'error', reason: 'target_error', findings: [] };
  }
  const form = mayCarryObservation(response) ? detectReflection(decodeBody(response.body)) : null;
  const findings = form === null ? [] : [reflectionFinding(input, form)];
  if (isNormalPage(response)) {
    return { conclusive: true, outcome: 'checked', reason: undefined, findings };
  }
  // The answer was not a normal page, so the absence of the indicator is not
  // established. A marker the server answered with is still reported.
  return { conclusive: false, ...unavailableOutcome(response), findings };
}

/** The finding of one reflected marker. */
function reflectionFinding(input: ProbeInput, form: ReflectionForm): OccurrenceFinding {
  return buildFinding({
    context: input.context,
    targetKey: input.candidate.targetKey,
    checkId: 'active',
    issueId: REFLECTION_ISSUE_ID,
    subject: input.parameter,
    safeLocation: input.safeLocation,
    validation: 'Indicator',
    confidence: 'low',
    evidence: { parameter: input.parameter, form },
  });
}

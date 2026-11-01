/**
 * The report of a scan (ADR-0052 section 12).
 *
 * The report is rendered from safe records only: the occurrence records, the
 * coverage rows and the groups of ADR-0052 section 4. A raw URL, a query value
 * and a response body never reach it, because the package never holds them.
 *
 * Two renderings share one model: a machine JSON report and a standalone HTML
 * report. The HTML rendering lives in `report-html.ts` and is re-exported
 * here, so the package keeps one entry point for a report.
 *
 * The HTML report escapes every text and every attribute, needs no external
 * script and no content delivery network, and carries exactly one kind of
 * link: a link into the dashboard of the platform, built from the trusted base
 * the app configured. The location of a finding is always text.
 */

import { summarizeCoverage, type CoverageSummary } from './coverage.js';
import { activeOccurrences, type EvidenceSample, type GroupOccurrence, type GroupStatus, type IssueGroup } from './group.js';
import { assessGroupRisk, assessOccurrenceRisk, type RiskAssessment } from './risk.js';
import type {
  ArchiveReason,
  CheckId,
  Comparison,
  Confidence,
  CoverageEntry,
  ExceptionKind,
  OccurrenceState,
  Severity,
  Validation,
} from './types.js';

/** The trusted dashboard of the platform, as the app configured it. */
export interface TrustedDashboard {
  /** The absolute base URL of the dashboard. */
  readonly baseUrl: string;
}

/** The route of the scanner section of the dashboard. */
const DASHBOARD_ROUTE: readonly string[] = Object.freeze(['admin', 'web-scan']);

/** The scan a report describes. */
export interface ReportScan {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?: string;
  readonly partialCoverage: boolean;
  readonly requests: number;
  readonly pages: number;
  readonly durationMs: number;
}

/** Everything a report renders. */
export interface ReportInput {
  readonly site: { readonly hostname: string };
  readonly scan: ReportScan;
  readonly groups: readonly IssueGroup[];
  readonly coverage: readonly CoverageEntry[];
  /** The trusted dashboard. Without it the report carries no link at all. */
  readonly dashboard?: TrustedDashboard;
  /** The moment the report was made, as the caller formatted it. */
  readonly generatedAt?: string;
}

/** One occurrence of a report. */
export interface ReportOccurrence {
  readonly occurrenceKey: string;
  readonly subject: string;
  readonly safeLocation: string;
  readonly severity: Severity;
  readonly validation: Validation;
  readonly confidence: Confidence;
  readonly evidenceHash: string;
  /** `null` means the evidence body was pruned, never an empty finding. */
  readonly evidence: Readonly<Record<string, string | number | boolean>> | null;
  readonly state: OccurrenceState;
  readonly comparison: Comparison;
  readonly archiveReason: ArchiveReason | null;
  /** The live administrator resolution, when there is one. */
  readonly exception: ExceptionKind | null;
  /** The risk of the occurrence, or null when it is not part of the active risk. */
  readonly risk: RiskAssessment | null;
}

/** One group of a report. */
export interface ReportGroup {
  readonly issueKey: string;
  readonly checkId: CheckId;
  readonly issueId: string;
  readonly severity: Severity;
  readonly status: GroupStatus;
  readonly fixed: boolean;
  readonly risk: RiskAssessment;
  readonly counts: {
    readonly occurrences: number;
    readonly outstanding: number;
    readonly excepted: number;
    readonly fixed: number;
    readonly archivedUnverified: number;
  };
  readonly affectedTargets: number;
  readonly evidenceSamples: readonly EvidenceSample[];
  readonly occurrences: readonly ReportOccurrence[];
}

/** The counts of a report. */
export interface ReportSummary {
  readonly groups: number;
  readonly outstandingOccurrences: number;
  readonly exceptedOccurrences: number;
  readonly fixedOccurrences: number;
  readonly archivedOccurrences: number;
  readonly fixedGroups: number;
  readonly openGroups: number;
  readonly blockedGroups: number;
  readonly resolvedByExceptionGroups: number;
  readonly highestRisk: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
}

/** The machine model of a report. */
export interface ScanReport {
  readonly schema: 'mergepilot.webscan.report';
  readonly version: 1;
  readonly generatedAt: string | null;
  readonly site: { readonly hostname: string };
  readonly scan: {
    readonly status: 'completed' | 'stopped' | 'failed';
    readonly reason: string | null;
    readonly partialCoverage: boolean;
    readonly requests: number;
    readonly pages: number;
    readonly durationMs: number;
  };
  readonly summary: ReportSummary;
  readonly groups: readonly ReportGroup[];
  readonly coverage: CoverageSummary;
  readonly limitations: readonly string[];
  readonly dashboardUrl: string | null;
}

/**
 * Builds the trusted link into the dashboard.
 *
 * The base must be an absolute http or https URL without credentials, and
 * every segment is encoded. A base that names another scheme, a base that
 * carries a userinfo and a base that is not a URL produce no link at all, so a
 * hostile configuration can never make a foreign address clickable.
 */
export function trustedDashboardUrl(
  dashboard: TrustedDashboard | undefined,
  segments: readonly string[],
): string | undefined {
  if (dashboard === undefined || segments.length === 0) {
    return undefined;
  }
  const base = parseDashboardBase(dashboard.baseUrl);
  if (base === undefined) {
    return undefined;
  }
  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/** The parsed base of a trusted dashboard. */
export function parseDashboardBase(raw: string): { origin: string; pathname: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  if (parsed.hostname === '') {
    return undefined;
  }
  return { origin: parsed.origin, pathname: parsed.pathname };
}

/** The occurrence of a report. */
function reportOccurrence(
  occurrence: GroupOccurrence,
  affectedUrls: number,
): ReportOccurrence {
  const active = occurrence.state === 'outstanding' && occurrence.exception === undefined;
  return {
    occurrenceKey: occurrence.occurrenceKey,
    subject: occurrence.subject,
    safeLocation: occurrence.safeLocation,
    severity: occurrence.severity,
    validation: occurrence.validation,
    confidence: occurrence.confidence,
    evidenceHash: occurrence.evidenceHash,
    evidence: occurrence.evidence,
    state: occurrence.state,
    comparison: occurrence.comparison,
    archiveReason: occurrence.archiveReason ?? null,
    exception: occurrence.exception ?? null,
    risk: active ? assessOccurrenceRisk(occurrence, affectedUrls) : null,
  };
}

/** The group of a report. */
function reportGroup(group: IssueGroup): ReportGroup {
  const affectedUrls = new Set(activeOccurrences(group).map((occurrence) => occurrence.targetKey)).size;
  return {
    issueKey: group.issueKey,
    checkId: group.checkId,
    issueId: group.issueId,
    severity: group.severity,
    status: group.status,
    fixed: group.fixed,
    risk: assessGroupRisk(group),
    counts: {
      occurrences: group.occurrences.length,
      outstanding: group.outstandingCount,
      excepted: group.exceptedCount,
      fixed: group.fixedCount,
      archivedUnverified: group.archivedUnverifiedCount,
    },
    affectedTargets: group.affectedTargets,
    evidenceSamples: group.evidenceSamples,
    occurrences: group.occurrences.map((occurrence) => reportOccurrence(occurrence, affectedUrls)),
  };
}

/** The counts of a report. */
function reportSummary(groups: readonly ReportGroup[]): ReportSummary {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  let outstandingOccurrences = 0;
  let exceptedOccurrences = 0;
  let fixedOccurrences = 0;
  let archivedOccurrences = 0;
  let fixedGroups = 0;
  let openGroups = 0;
  let blockedGroups = 0;
  let resolvedByExceptionGroups = 0;
  let highestRisk = 0;
  for (const group of groups) {
    bySeverity[group.severity] += 1;
    outstandingOccurrences += group.counts.outstanding;
    exceptedOccurrences += group.counts.excepted;
    fixedOccurrences += group.counts.fixed;
    archivedOccurrences += group.counts.archivedUnverified;
    highestRisk = Math.max(highestRisk, group.risk.score);
    if (group.status === 'fixed') {
      fixedGroups += 1;
    } else if (group.status === 'open') {
      openGroups += 1;
    } else if (group.status === 'blocked') {
      blockedGroups += 1;
    } else {
      resolvedByExceptionGroups += 1;
    }
  }
  return {
    groups: groups.length,
    outstandingOccurrences,
    exceptedOccurrences,
    fixedOccurrences,
    archivedOccurrences,
    fixedGroups,
    openGroups,
    blockedGroups,
    resolvedByExceptionGroups,
    highestRisk,
    bySeverity,
  };
}

/** The limitations of a report. */
function limitationsOf(
  input: ReportInput,
  summary: ReportSummary,
): readonly string[] {
  const limitations: string[] = [];
  if (input.scan.status === 'stopped') {
    limitations.push(
      `The scan stopped before it finished${input.scan.reason === undefined ? '' : ` (${input.scan.reason})`}. Its findings are observations, not a baseline, and an occurrence the scan did not reach keeps its previous state.`,
    );
  }
  if (input.scan.status === 'failed') {
    limitations.push(
      `The scan failed${input.scan.reason === undefined ? '' : ` (${input.scan.reason})`}. Its findings are observations, not a baseline, and an occurrence the scan did not reach keeps its previous state.`,
    );
  }
  if (input.scan.partialCoverage) {
    limitations.push(
      'The scan covered only part of the authorized scope. A coverage row that was not checked never proves that an occurrence is gone.',
    );
  }
  if (summary.archivedOccurrences > 0) {
    limitations.push(
      'An archived occurrence was never proven fixed. Its evidence was pruned by the retention policy, so its blocker stays open until the occurrence is observed again or proven absent.',
    );
  }
  if (summary.resolvedByExceptionGroups > 0) {
    limitations.push(
      'A finding that carries an administrator resolution stays visible and stays labelled. A resolution is not a remediation, so it never marks a finding fixed.',
    );
  }
  limitations.push('The risk score is an internal prioritization aid. It is not a CVSS score.');
  limitations.push(
    'Only GET and HEAD requests were sent. No form was submitted, no script was executed and no page of the site was requested outside the authorized scope.',
  );
  return limitations;
}

/**
 * Builds the machine model of a report.
 *
 * The model holds safe records only, and every count of the summary is read
 * from the groups, so the JSON report and the HTML report always agree.
 */
export function buildScanReport(input: ReportInput): ScanReport {
  const groups = input.groups.map(reportGroup);
  const summary = reportSummary(groups);
  return {
    schema: 'mergepilot.webscan.report',
    version: 1,
    generatedAt: input.generatedAt ?? null,
    site: { hostname: input.site.hostname },
    scan: {
      status: input.scan.status,
      reason: input.scan.reason ?? null,
      partialCoverage: input.scan.partialCoverage,
      requests: input.scan.requests,
      pages: input.scan.pages,
      durationMs: input.scan.durationMs,
    },
    summary,
    groups,
    coverage: summarizeCoverage(input.coverage),
    limitations: limitationsOf(input, summary),
    dashboardUrl: trustedDashboardUrl(input.dashboard, DASHBOARD_ROUTE) ?? null,
  };
}

/** Renders the machine report as JSON. */
export function renderReportJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}

export { renderReportHtml } from './report-html.js';

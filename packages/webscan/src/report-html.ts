/**
 * The standalone HTML rendering of a report (ADR-0052 section 12).
 *
 * The rendering is separate from the model of the report, so the model stays
 * a plain data structure that the JSON rendering and the dashboard can share.
 *
 * Every text and every attribute of the document is escaped, the document
 * carries no script and no external resource, and the only link it holds is
 * the trusted link into the dashboard of the platform. The location of a
 * finding is always text, never a link.
 */

import { parseDashboardBase, type ReportGroup, type ReportOccurrence, type ScanReport } from './report.js';
import type { Comparison, ExceptionKind, OccurrenceState, Severity } from './types.js';

/** The label of every state of an occurrence. */
const STATE_LABELS: Readonly<Record<OccurrenceState, string>> = Object.freeze({
  outstanding: 'Outstanding',
  fixed: 'Fixed',
  archived: 'Archived',
});

/** The label of every comparison. */
const COMPARISON_LABELS: Readonly<Record<Comparison, string>> = Object.freeze({
  New: 'New',
  Unchanged: 'Unchanged',
  Fixed: 'Fixed',
  'Not checked': 'Not checked',
});

/** The label of every administrator resolution. */
const EXCEPTION_LABELS: Readonly<Record<ExceptionKind, string>> = Object.freeze({
  accepted: 'Accepted',
  false_positive: 'False positive',
});

/** The label of every group status. */
const GROUP_STATUS_LABELS: Readonly<Record<ReportGroup['status'], string>> = Object.freeze({
  fixed: 'Fixed',
  open: 'Open',
  blocked: 'Unresolved: an archived member was never proven fixed',
  resolved_by_exception: 'Resolved by exception',
});

/**
 * Escapes one text for HTML.
 *
 * The text and the attributes of the report share one escaper, so a hostile
 * subject, a hostile location, a hostile evidence value and a hostile label
 * stay inert.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The styles of the standalone report. */
const REPORT_STYLE = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1c2024;line-height:1.5}
main{max-width:1100px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #d7dbe0;padding-bottom:6px}
h3{font-size:16px;margin:0 0 4px}
h4{font-size:13px;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#5b6570}
p.meta{margin:2px 0;color:#5b6570;font-size:13px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px;background:#fff}
th,td{border:1px solid #d7dbe0;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef0f3}
td.hash{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
article.group{background:#fff;border:1px solid #d7dbe0;border-radius:6px;padding:12px 16px;margin:12px 0}
.badge{display:inline-block;border:1px solid #b9c0c8;border-radius:10px;padding:0 8px;font-size:12px}
ul{margin:4px 0 8px;padding-left:20px;font-size:13px}
.note{font-size:12px;color:#5b6570}
`;

/** The evidence of an occurrence, as HTML. */
function renderEvidence(
  evidence: Readonly<Record<string, string | number | boolean>> | null,
): string {
  if (evidence === null) {
    return 'Evidence not retained';
  }
  const entries = Object.keys(evidence)
    .sort()
    .map((key) => `<li>${escapeHtml(key)}: ${escapeHtml(String(evidence[key]))}</li>`)
    .join('');
  return `<ul>${entries}</ul>`;
}

/** The risk of a group, as HTML. */
function renderRisk(risk: ScanReport['groups'][number]['risk']): string {
  const factors = risk.factors;
  const source =
    risk.source === null
      ? 'no active observation'
      : `${escapeHtml(risk.source.severity)} / ${escapeHtml(risk.source.confidence)} confidence / ${escapeHtml(risk.source.validation)}`;
  return `<p class="meta">Risk ${risk.score.toFixed(2)} (not a CVSS score) = severity base ${factors.severityBase} &times; confidence ${factors.confidence} &times; validation ${factors.validation} &times; surface ${factors.surface} (affected targets ${factors.affectedUrls}). Factors taken from: ${source}.</p>`;
}

/** The occurrences of a group, as an HTML table. */
function renderOccurrences(occurrences: readonly ReportOccurrence[]): string {
  const rows = occurrences
    .map((occurrence) => {
      const resolution =
        occurrence.exception === null ? '—' : escapeHtml(EXCEPTION_LABELS[occurrence.exception]);
      const archive =
        occurrence.archiveReason === null ? '—' : escapeHtml(occurrence.archiveReason);
      return `<tr><td>${escapeHtml(occurrence.subject)}</td><td>${escapeHtml(occurrence.safeLocation)}</td><td>${escapeHtml(occurrence.severity)}</td><td>${escapeHtml(occurrence.validation)}</td><td>${escapeHtml(occurrence.confidence)}</td><td>${escapeHtml(COMPARISON_LABELS[occurrence.comparison])}</td><td>${escapeHtml(STATE_LABELS[occurrence.state])}</td><td>${resolution}</td><td>${archive}</td><td>${renderEvidence(occurrence.evidence)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Subject</th><th>Location</th><th>Severity</th><th>Validation</th><th>Confidence</th><th>Comparison</th><th>State</th><th>Resolution</th><th>Archive reason</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The evidence samples of a group, as HTML. */
function renderSamples(group: ReportGroup): string {
  if (group.evidenceSamples.length === 0) {
    return '<p class="note">No unresolved occurrence carries a sample.</p>';
  }
  const items = group.evidenceSamples
    .map(
      (sample) =>
        `<li>${escapeHtml(sample.safeLocation)} &mdash; ${escapeHtml(sample.subject)} <span class="hash">${escapeHtml(sample.evidenceHash)}</span></li>`,
    )
    .join('');
  return `<ul>${items}</ul>`;
}

/** One group of the HTML report. */
function renderGroup(group: ReportGroup): string {
  const counts = group.counts;
  return `<article class="group"><h3>${escapeHtml(group.issueId)} <span class="badge">${escapeHtml(group.severity)}</span></h3><p class="meta">Check ${escapeHtml(group.checkId)} &middot; Status: ${escapeHtml(GROUP_STATUS_LABELS[group.status])} &middot; Affected targets: ${group.affectedTargets}</p>${renderRisk(group.risk)}<p class="meta">Occurrences ${counts.occurrences} &middot; Outstanding ${counts.outstanding} &middot; Resolved by exception ${counts.excepted} &middot; Fixed ${counts.fixed} &middot; Archived and never proven fixed ${counts.archivedUnverified}</p><h4>Evidence samples</h4>${renderSamples(group)}<h4>Occurrences</h4>${renderOccurrences(group.occurrences)}</article>`;
}

/** The executive summary of the HTML report. */
function renderSummary(report: ScanReport): string {
  const summary = report.summary;
  const items = [
    `Issue groups: ${summary.groups}`,
    `Outstanding occurrences: ${summary.outstandingOccurrences}`,
    `Occurrences resolved by an administrator: ${summary.exceptedOccurrences}`,
    `Occurrences proven fixed: ${summary.fixedOccurrences}`,
    `Archived occurrences that were never proven fixed: ${summary.archivedOccurrences}`,
    `Groups fixed: ${summary.fixedGroups} &middot; open: ${summary.openGroups} &middot; blocked: ${summary.blockedGroups} &middot; resolved by exception: ${summary.resolvedByExceptionGroups}`,
    `Highest risk score: ${summary.highestRisk.toFixed(2)}`,
  ]
    .map((item) => `<li>${item}</li>`)
    .join('');
  const severities = (Object.keys(summary.bySeverity) as Severity[])
    .map(
      (severity) =>
        `<tr><td>${escapeHtml(severity)}</td><td>${summary.bySeverity[severity]}</td></tr>`,
    )
    .join('');
  return `<ul>${items}</ul><h4>Groups by severity</h4><table><thead><tr><th>Severity</th><th>Groups</th></tr></thead><tbody>${severities}</tbody></table>`;
}

/** The coverage of the HTML report. */
function renderCoverage(report: ScanReport): string {
  const rows = report.coverage.byCheck
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.checkId)}</td><td>${entry.checked}</td><td>${entry.errors}</td><td>${entry.notVisited}</td><td>${entry.complete}</td><td>${entry.restricted}</td><td>${entry.unknown}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Check</th><th>Checked</th><th>Errors</th><th>Not visited</th><th>Complete subject scope</th><th>Restricted subject scope</th><th>Unknown subject scope</th></tr></thead><tbody>${rows}</tbody></table><p class="note">A row that was not checked never proves that an occurrence is gone. A restricted subject scope covers only the subjects it names, and a row with an unknown scope covers none.</p>`;
}

/**
 * Renders the standalone HTML report.
 *
 * The document carries no script and no external resource. Every text and
 * every attribute is escaped, and the only link is the trusted link into the
 * dashboard of the platform.
 */
export function renderReportHtml(report: ScanReport): string {
  const scan = report.scan;
  const link =
    report.dashboardUrl === null || parseDashboardBase(report.dashboardUrl) === undefined
      ? ''
      : `<p><a href="${escapeHtml(report.dashboardUrl)}">Open the scanner in the dashboard</a></p>`;
  const limitations = report.limitations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
  const groups = report.groups.map(renderGroup).join('');
  const generated =
    report.generatedAt === null
      ? ''
      : `<p class="meta">Generated at ${escapeHtml(report.generatedAt)}</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website security scan report &mdash; ${escapeHtml(report.site.hostname)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Website security scan report</h1>
<p class="meta">Site: ${escapeHtml(report.site.hostname)}</p>
<p class="meta">Scan: ${escapeHtml(scan.status)}${scan.reason === null ? '' : ` (${escapeHtml(scan.reason)})`} &middot; ${scan.requests} requests &middot; ${scan.pages} pages &middot; partial coverage: ${scan.partialCoverage ? 'yes' : 'no'}</p>
${generated}
${link}
</header>
<section id="summary">
<h2>Executive summary</h2>
${renderSummary(report)}
</section>
<section id="findings">
<h2>Technical findings</h2>
${groups === '' ? '<p class="note">The scan reported no issue.</p>' : groups}
</section>
<section id="coverage">
<h2>Coverage</h2>
${renderCoverage(report)}
</section>
<section id="limitations">
<h2>Limitations</h2>
<ul>${limitations}</ul>
</section>
</main>
</body>
</html>
`;
}

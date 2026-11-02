import { createHash } from 'node:crypto';
import type { Severity } from '@mergepilot/webscan';
import type {
  AlertExceptionCommentAction,
  AlertFixedCommentAction,
  AlertMarkerKind,
  AlertOpenIssueAction,
  AlertSeverityCounts,
} from './alerts-types.js';
import type { WebScanAlertEpisode } from './types.js';

/**
 * The publication payload of an alert (ADR-0052 section 8).
 *
 * Everything that leaves the platform for GitHub is built here, out of bounded
 * aggregates only. A hostname, an affected URL, an evidence fact, a subject, an
 * occurrence key, the free-form reason of a resolution or any other free text of
 * the ledger never reaches a body: a body carries aggregate counts by severity,
 * the platform dashboard link the caller supplies, and the deterministic delivery
 * marker that a marker reconciliation looks for.
 */

/** The number of hex characters of a digest inside a marker. */
const MARKER_DIGEST_LENGTH = 32;

/** The prefix of every delivery marker. */
const MARKER_PREFIX = 'mp-webscan';

/** The hidden line that carries the delivery marker inside a body. */
const MARKER_LINE = 'mergepilot-webscan-alert';

/** The display label of every severity. */
const SEVERITY_LABELS: Readonly<Record<Severity, string>> = Object.freeze({
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
});

/** A short, stable digest of a string. */
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, MARKER_DIGEST_LENGTH);
}

/**
 * The deterministic delivery marker of a write of an episode.
 *
 * The same episode and the same kind of write always carry the same marker,
 * and two episodes never carry the same one. The marker of the issue is the
 * default one, so a replacement issue for a confirmed missing issue reuses the
 * marker of the issue it replaces and a reconciliation finds it.
 *
 * Every other write of the episode carries its own marker: a delivery record
 * is unique per marker, so a comment must never overwrite the record of the
 * issue it comments on.
 */
export function deliveryMarker(
  episode: WebScanAlertEpisode,
  kind: AlertMarkerKind = 'issue',
): string {
  return `${MARKER_PREFIX}-${digest(`${kind}:v1:${episode.episodeKey}`)}`;
}

/** The aggregate counts by severity of a list of findings. */
export function severityCounts(severities: readonly Severity[]): AlertSeverityCounts {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const severity of severities) {
    counts[severity] += 1;
  }
  return counts;
}

/** The platform dashboard link of one site. */
export function dashboardLink(baseUrl: string, siteId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/admin/web-scan/sites/${encodeURIComponent(siteId)}`;
}

/** The hidden marker line of a body. */
function markerLine(marker: string): string {
  return `<!-- ${MARKER_LINE}:${marker} -->`;
}

/** The count lines of a body. */
function countLines(counts: AlertSeverityCounts): string[] {
  return (Object.keys(SEVERITY_LABELS) as Severity[]).map(
    (severity) => `- ${SEVERITY_LABELS[severity]}: ${counts[severity]}`,
  );
}

/**
 * The body of the issue of an episode.
 *
 * It carries the aggregate counts by severity, the dashboard link of the site
 * and the delivery marker. It carries no hostname, no affected URL, no
 * evidence, no subject and no occurrence key.
 */
export function renderIssueBody(action: AlertOpenIssueAction): string {
  return [
    'The website security scan found findings that need attention.',
    '',
    ...countLines(action.severityCounts),
    '',
    `Dashboard: ${action.dashboardUrl}`,
    '',
    markerLine(action.deliveryMarker),
  ].join('\n');
}

/**
 * The body of the comment that reports a proven fixed group.
 *
 * It uses the same aggregate format as the issue body.
 */
export function renderFixedCommentBody(action: AlertFixedCommentAction): string {
  return [
    'The website security scan proved every finding of this group fixed.',
    '',
    ...countLines(action.severityCounts),
    '',
    `Dashboard: ${action.dashboardUrl}`,
    '',
    markerLine(action.deliveryMarker),
  ].join('\n');
}

/**
 * The body of the comment that reports a group an administrator resolved.
 *
 * It names the kind of the resolution, its bounded reason category and its
 * expiry. It never names the free-form reason of the resolution, and it never
 * claims that the findings were fixed: an accepted risk is not a remediation.
 */
export function renderExceptionCommentBody(action: AlertExceptionCommentAction): string {
  const expiry = action.exception.expiresAt ?? 'no expiry';
  return [
    'The website security scan resolved this group by an administrator resolution.',
    '',
    `- Resolution: ${action.exception.kind}`,
    `- Reason category: ${action.exception.reasonCategory}`,
    `- Expiry: ${expiry}`,
    '',
    ...countLines(action.severityCounts),
    '',
    `Dashboard: ${action.dashboardUrl}`,
    '',
    markerLine(action.deliveryMarker),
  ].join('\n');
}

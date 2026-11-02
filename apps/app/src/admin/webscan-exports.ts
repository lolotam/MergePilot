import type { FastifyInstance } from 'fastify';
import {
  buildScanReport,
  groupOccurrences,
  renderReportHtml,
  renderReportJson,
  type OccurrenceRecord,
  type ReportScan,
  type ScanException,
} from '@mergepilot/webscan';
import { sendError } from '../api/helpers.js';
import { WebScanExportQuerySchema } from '../api/contract-webscan.js';
import type { AppConfig } from '../core/config.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanException, WebScanScan } from '../webscan/types.js';
import {
  parseWebScanParam,
  sendWebScanNotFound,
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';
import { toScanFindingView, type WebScanFindingView } from './webscan-scans.js';

/**
 * The report export of a scan (ADR-0052 section 12).
 *
 * The report is built from the same safe records the dashboard shows: the findings of
 * the scan itself, its live resolutions and the coverage the scan recorded. The
 * rendering itself belongs to the scanner package; this file only maps the stored
 * rows onto the package's record shapes and answers with the rendered text.
 *
 * The filename is a fixed pattern around the scan id, so no field of the response and
 * no target of the scan can shape it.
 */

/**
 * The raw evidence value a client sees, `null` when the body was pruned or when it
 * produced no all-primitive record: the renderer is never handed a partial truth.
 */
function toReportEvidence(evidence: unknown): Record<string, string | number | boolean> | null {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return null;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(evidence as Record<string, unknown>)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      return null;
    }
    result[key] = item;
  }
  return result;
}

/** One occurrence row, as the display layer of the package reads it. */
function toOccurrenceRecord(occurrence: WebScanFindingView): OccurrenceRecord {
  return {
    occurrenceKey: occurrence.occurrenceKey,
    targetKey: occurrence.targetKey,
    issueKey: occurrence.issueKey,
    checkId: occurrence.checkId,
    issueId: occurrence.issueId,
    subject: occurrence.subject,
    severity: occurrence.severity,
    validation: occurrence.validation,
    confidence: occurrence.confidence,
    safeLocation: occurrence.safeLocation,
    evidenceHash: occurrence.evidenceHash,
    evidence: toReportEvidence(occurrence.evidence),
    state: occurrence.state,
    comparison: occurrence.comparison,
  };
}

/**
 * One administrator resolution, as the package reads it.
 *
 * The package never reads a reason, a reason category or a revocation flag: it only
 * knows which identity a resolution covers and how long it lives. The free-form reason
 * of the administrator stays in the dashboard and in the audit log.
 */
function toScanException(exception: WebScanException): ScanException {
  return {
    occurrenceKey: exception.occurrenceKey,
    evidenceHash: exception.evidenceHash,
    kind: exception.kind,
    expiresAt: exception.expiresAt === null ? null : exception.expiresAt.getTime(),
  };
}

/** The terminal scan rows the report renderer accepts. */
type ReportScanRow = Omit<WebScanScan, 'status'> & {
  status: 'completed' | 'stopped' | 'failed';
};

/** True when the scan reached a terminal state and a report can describe it. */
function isTerminalScan(scan: WebScanScan): scan is WebScanScan & {
  status: 'completed' | 'stopped' | 'failed';
} {
  return scan.status === 'completed' || scan.status === 'stopped' || scan.status === 'failed';
}

/** Builds the report model of one terminal scan, ready for either rendering. */
async function buildStoredScanReport(
  store: WebScanStore,
  scan: ReportScanRow,
  dashboardBaseUrl: string,
): Promise<{ report: ReturnType<typeof buildScanReport>; site: { hostname: string } } | null> {
  const site = await store.getSite(scan.siteId);
  if (site === null) return null;
  // The report describes the scan itself: it uses the findings of that scan and not
  // the current ledger of the site. The resolutions are the live ones.
  const findings = await store.listScanFindings(scan.id);
  const exceptions = await store.listLiveExceptions(scan.siteId, new Date());
  const coverage = scan.coverageSummary ?? [];
  const reason =
    scan.status === 'stopped'
      ? (scan.stopReason ?? undefined)
      : scan.status === 'failed'
        ? (scan.failReason ?? undefined)
        : undefined;
  const reportScan: ReportScan = {
    status: scan.status,
    // The reason is absent when the scan has none: the package reads an absent
    // reason as a scan that ended without one.
    ...(reason === undefined ? {} : { reason }),
    partialCoverage: coverage.some((entry) => entry.outcome !== 'checked'),
    requests: scan.requests,
    pages: scan.pages,
    durationMs: scan.durationMs,
  };
  const report = buildScanReport({
    site: { hostname: site.hostname },
    scan: reportScan,
    groups: groupOccurrences(
      findings.map((finding) => toOccurrenceRecord(toScanFindingView(finding, exceptions))),
      {
        exceptions: exceptions.map((exception) => toScanException(exception)),
        now: Date.now(),
      },
    ),
    coverage,
    dashboard: { baseUrl: dashboardBaseUrl },
  });
  return { report, site };
}

export function registerWebScanExportRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  deps: { store: WebScanStore; config: Pick<AppConfig, 'baseUrl'> },
): void {
  app.get(
    '/api/admin/web-scan/scans/:scanId/export',
    { preHandler: [guard] },
    async (request, reply) => {
      if (webScanAdminId(request) === undefined) {
        return sendWebScanNotFound(reply);
      }
      const scanId = parseWebScanParam(request, reply, 'scanId');
      if (typeof scanId !== 'string') return scanId;
      const format = WebScanExportQuerySchema.safeParse(request.query ?? {});
      if (!format.success) {
        return sendWebScanValidationError(reply, format.error);
      }

      const found = await withWebScanErrors(reply, () => deps.store.getScan(scanId));
      if (!found.ok) return found.reply;
      if (found.value === null) return sendWebScanNotFound(reply);
      const scan = found.value;

      // A scan that has not finished has no outcome to report: the report of a
      // running scan would claim a conclusion the scan did not reach.
      if (!isTerminalScan(scan)) {
        return sendError(
          reply,
          409,
          'conflict',
          'A scan that has not finished has no report yet',
        );
      }

      const built = await withWebScanErrors(reply, () =>
        buildStoredScanReport(deps.store, scan, deps.config.baseUrl),
      );
      if (!built.ok) return built.reply;
      if (built.value === null) return sendWebScanNotFound(reply);

      const isJson = format.data.format === 'json';
      const body = isJson
        ? renderReportJson(built.value.report)
        : renderReportHtml(built.value.report);
      // The filename is a fixed pattern around the scan id: no hostname, no target
      // and no secret of the scan can shape it.
      const filename = `webscan-report-${scan.id}.${format.data.format}`;
      return reply
        .status(200)
        .header('content-type', isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(body);
    },
  );
}

import type { FastifyInstance } from 'fastify';
import type { Comparison, CoverageEntry } from '@mergepilot/webscan';
import {
  WebScanCoverageEntrySchema,
  WebScanEnqueueManualSchema,
  WebScanOccurrenceDtoSchema,
  WebScanPageQuerySchema,
  type WebScanCoverageEntryDto,
  type WebScanOccurrenceDto,
  type WebScanScanDto,
} from '../api/contract-webscan.js';
import type { WebScanStore } from '../webscan/store.js';
import type { WebScanException, WebScanScan, WebScanScanFinding } from '../webscan/types.js';
import {
  parseWebScanParam,
  sendWebScanNotFound,
  sendWebScanValidationError,
  webScanAdminId,
  withWebScanErrors,
  type WebScanAdminGuard,
} from './webscan-http.js';
import { buildScope, parseSiteId } from './webscan-sites.js';
import { definedFields } from './webscan-params.js';

/**
 * The scan routes of the scanner (ADR-0052 sections 6 and 7): the enqueue, the
 * history, the detail and the stop of a scan.
 *
 * A manual scan is an authorization act like a registration: its body must carry
 * `authorize: true`, the fresh confirmation of ADR-0052 section 6, and it is refused
 * before anything is queued otherwise. The stop is the administrator-facing half of
 * the attempt fence: it marks a queued or running scan stopped, and the worker stops
 * because its scan is no longer running; the cancelled attempt may only add its counters.
 */

/**
 * Builds one scan response from named fields; never a spread of the scan row. The
 * internal lock/lease columns (attempt id, heartbeat, outbox state, idempotency
 * key, effective settings) never leave the store.
 */
export function toWebScanScanDto(scan: WebScanScan): WebScanScanDto {
  return {
    id: scan.id,
    siteId: scan.siteId,
    trigger: scan.trigger,
    status: scan.status,
    scheduledFor: scan.scheduledFor === null ? null : scan.scheduledFor.toISOString(),
    requests: scan.requests,
    pages: scan.pages,
    durationMs: scan.durationMs,
    stopReason: scan.stopReason,
    failReason: scan.failReason,
    coverageSummary:
      scan.coverageSummary === null
        ? null
        : scan.coverageSummary.map((entry) => toWebScanCoverageDto(entry)),
    authorizationAuditId: scan.authorizationAuditId,
    scopeVersion: scan.scopeVersion,
    createdAt: scan.createdAt.toISOString(),
    startedAt: scan.startedAt === null ? null : scan.startedAt.toISOString(),
    finishedAt: scan.finishedAt === null ? null : scan.finishedAt.toISOString(),
  };
}

/** One coverage row of a scan or of a site, in the response shape. */
export function toWebScanCoverageDto(entry: CoverageEntry): WebScanCoverageEntryDto {
  return WebScanCoverageEntrySchema.parse({
    targetKey: entry.targetKey,
    checkId: entry.checkId,
    checkVersion: entry.checkVersion,
    evaluatedIssueIds: [...entry.evaluatedIssueIds],
    outcome: entry.outcome,
    reason: entry.reason ?? null,
  });
}

/**
 * One finding of a scan, as the dashboard and the report read it.
 *
 * A scan keeps its own findings, so the detail and the report of a scan show what
 * that scan found and not what the ledger of the site holds now: an older scan
 * keeps showing the findings of its own run.
 */
export interface WebScanFindingView {
  id: string;
  occurrenceKey: string;
  targetKey: string;
  issueKey: string;
  checkId: WebScanScanFinding['checkId'];
  checkVersion: number;
  issueId: string;
  subject: string;
  severity: WebScanScanFinding['severity'];
  validation: WebScanScanFinding['validation'];
  confidence: WebScanScanFinding['confidence'];
  safeLocation: string;
  evidenceHash: string;
  evidence: unknown | null;
  /** The state of the occurrence in this scan. */
  state: 'outstanding' | 'fixed';
  comparison: Comparison;
  /** The live resolution that covers the finding, when there is one. */
  exceptionId: string | null;
  /** When the scan observed the finding. */
  observedAt: Date;
}

/**
 * Builds the view of one finding of a scan.
 *
 * A finding whose comparison is `Fixed` is the proof that the occurrence is gone, so
 * it is a fixed occurrence. A resolution covers a finding while its occurrence key
 * and its evidence hash both match.
 */
export function toScanFindingView(
  finding: WebScanScanFinding,
  exceptions: readonly WebScanException[],
): WebScanFindingView {
  const exception = exceptions.find(
    (row) =>
      row.occurrenceKey === finding.occurrenceKey && row.evidenceHash === finding.evidenceHash,
  );
  return {
    id: finding.id,
    occurrenceKey: finding.occurrenceKey,
    targetKey: finding.targetKey,
    issueKey: finding.issueKey,
    checkId: finding.checkId,
    checkVersion: finding.checkVersion,
    issueId: finding.issueId,
    subject: finding.subject,
    severity: finding.severity,
    validation: finding.validation,
    confidence: finding.confidence,
    safeLocation: finding.safeLocation,
    evidenceHash: finding.evidenceHash,
    evidence: finding.evidence,
    state: finding.comparison === 'Fixed' ? 'fixed' : 'outstanding',
    comparison: finding.comparison,
    exceptionId: exception?.id ?? null,
    observedAt: finding.createdAt,
  };
}

/** Builds one occurrence response from named fields; the store internals stay out. */
export function toWebScanOccurrenceDto(occurrence: WebScanFindingView): WebScanOccurrenceDto {
  return WebScanOccurrenceDtoSchema.parse({
    id: occurrence.id,
    occurrenceKey: occurrence.occurrenceKey,
    targetKey: occurrence.targetKey,
    issueKey: occurrence.issueKey,
    checkId: occurrence.checkId,
    checkVersion: occurrence.checkVersion,
    issueId: occurrence.issueId,
    subject: occurrence.subject,
    severity: occurrence.severity,
    validation: occurrence.validation,
    confidence: occurrence.confidence,
    safeLocation: occurrence.safeLocation,
    evidenceHash: occurrence.evidenceHash,
    evidence: occurrence.evidence ?? null,
    state: occurrence.state,
    archiveReason: null,
    comparison: occurrence.comparison,
    exceptionId: occurrence.exceptionId,
    lastObservedAt: occurrence.observedAt.toISOString(),
    createdAt: occurrence.observedAt.toISOString(),
    updatedAt: occurrence.observedAt.toISOString(),
  });
}

export function registerWebScanScanRoutes(
  app: FastifyInstance,
  guard: WebScanAdminGuard,
  store: WebScanStore,
): void {
  app.post('/api/admin/web-scan/sites/:siteId/scans', { preHandler: [guard] }, async (request, reply) => {
    const adminId = webScanAdminId(request);
    if (adminId === undefined) {
      return sendWebScanNotFound(reply);
    }
    const siteId = parseSiteId(request, reply);
    if (typeof siteId !== 'string') return siteId;
    const parsed = WebScanEnqueueManualSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendWebScanValidationError(reply, parsed.error);
    const body = parsed.data;

    // The site is read before anything is computed or queued: an unknown site is a
    // miss, not an acquisition of a lock, and the override scope is built from the
    // site's canonical hostname and base URL rather than from the request.
    const site = await withWebScanErrors(reply, () => store.getSite(siteId));
    if (!site.ok) return site.reply;
    if (site.value === null) return sendWebScanNotFound(reply);

    const scope =
      body.scope === undefined
        ? undefined
        : buildScope(site.value.scope.hostname, site.value.scope.baseUrl, body.scope);

    // The `authorize` confirmation is contract-only: the store is never told of it.
    const queued = await withWebScanErrors(reply, () =>
      store.enqueueManualScan(
        adminId,
        definedFields({
          siteId,
          idempotencyKey: body.idempotencyKey,
          scope,
          checks: body.checks,
        }),
      ),
    );
    if (!queued.ok) return queued.reply;
    const result = { scan: toWebScanScanDto(queued.value.scan), replayed: queued.value.replayed };
    if (queued.value.replayed) {
      return reply.status(200).send(result);
    }
    return reply.status(201).send(result);
  });

  app.get('/api/admin/web-scan/sites/:siteId/scans', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendWebScanNotFound(reply);
    }
    const siteId = parseSiteId(request, reply);
    if (typeof siteId !== 'string') return siteId;
    const page = WebScanPageQuerySchema.safeParse(request.query ?? {});
    if (!page.success) return sendWebScanValidationError(reply, page.error);

    // An unknown site is a miss, not an empty page: a typo in an id shall not look
    // like a site without history.
    const site = await withWebScanErrors(reply, () => store.getSite(siteId));
    if (!site.ok) return site.reply;
    if (site.value === null) return sendWebScanNotFound(reply);

    const scans = await withWebScanErrors(reply, () => store.listScans(siteId));
    if (!scans.ok) return scans.reply;
    const items = scans.value.slice(page.data.offset, page.data.offset + page.data.limit);
    return reply.status(200).send({
      scans: items.map((scan) => toWebScanScanDto(scan)),
      limit: page.data.limit,
      offset: page.data.offset,
    });
  });

  app.get('/api/admin/web-scan/scans/:scanId', { preHandler: [guard] }, async (request, reply) => {
    if (webScanAdminId(request) === undefined) {
      return sendWebScanNotFound(reply);
    }
    const scanId = parseWebScanParam(request, reply, 'scanId');
    if (typeof scanId !== 'string') return scanId;

    const found = await withWebScanErrors(reply, () => store.getScan(scanId));
    if (!found.ok) return found.reply;
    if (found.value === null) return sendWebScanNotFound(reply);
    const scan = found.value;

    // The findings of the scan are its own: an older scan keeps showing what it
    // found, and not what the ledger of the site holds now.
    const findings = await withWebScanErrors(reply, () => store.listScanFindings(scanId));
    if (!findings.ok) return findings.reply;
    const exceptions = await withWebScanErrors(reply, () =>
      store.listLiveExceptions(scan.siteId, new Date()),
    );
    if (!exceptions.ok) return exceptions.reply;
    const coverage = scan.coverageSummary ?? [];
    return reply.status(200).send({
      scan: toWebScanScanDto(scan),
      coverage: coverage.map((entry) => toWebScanCoverageDto(entry)),
      occurrences: findings.value.map((finding) =>
        toWebScanOccurrenceDto(toScanFindingView(finding, exceptions.value)),
      ),
    });
  });

  app.post(
    '/api/admin/web-scan/scans/:scanId/stop',
    { preHandler: [guard] },
    async (request, reply) => {
      const adminId = webScanAdminId(request);
      if (adminId === undefined) {
        return sendWebScanNotFound(reply);
      }
      const scanId = parseWebScanParam(request, reply, 'scanId');
      if (typeof scanId !== 'string') return scanId;

      // The stop is idempotent: a scan that already has a terminal state comes back
      // unchanged, and both outcomes answer with the scan.
      const stopped = await withWebScanErrors(reply, () => store.stopScan(adminId, scanId));
      if (!stopped.ok) return stopped.reply;
      return reply.status(200).send({ scan: toWebScanScanDto(stopped.value.scan) });
    },
  );
}

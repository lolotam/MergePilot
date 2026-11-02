import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The report export of a scan (ADR-0052 section 12).
 *
 * The export is the rendered report of the scanner package, sent as an attachment
 * whose name is a fixed pattern around the scan id. A hostile finding stays inert in
 * the HTML rendering, and no hostname, target or secret of the scan shapes the file
 * name or the content type.
 *
 * The report describes the scan it belongs to: it shows the findings of that scan
 * and not the findings of a later run.
 */

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';
const HOSTILE_SUBJECT = '<script>alert("x")</script>';

const OCCURRENCE_A = 'a'.repeat(64);
const EVIDENCE_A = 'b'.repeat(64);
const OCCURRENCE_B = 'c'.repeat(64);
const EVIDENCE_B = 'd'.repeat(64);

/** The finding of the first scan: one missing header. */
const findingA = {
  occurrenceKey: OCCURRENCE_A,
  targetKey: 'target-a',
  issueKey: 'headers|headers/strict-transport-security|example.com',
  checkId: 'headers' as const,
  checkVersion: 1,
  issueId: 'headers/strict-transport-security',
  subject: HOSTILE_SUBJECT,
  severity: 'medium' as const,
  validation: 'Likely' as const,
  confidence: 'high' as const,
  safeLocation: 'https://example.com/',
  evidenceHash: EVIDENCE_A,
  evidence: { header: 'missing' },
  comparison: 'New' as const,
};

/** The finding of the second scan: another missing header. */
const findingB = {
  ...findingA,
  occurrenceKey: OCCURRENCE_B,
  targetKey: 'target-b',
  issueKey: 'headers|headers/content-security-policy|example.com',
  issueId: 'headers/content-security-policy',
  subject: 'Content-Security-Policy',
  evidenceHash: EVIDENCE_B,
};

/** The shape of the machine report the assertions read. */
interface MachineReport {
  groups: { occurrences: { occurrenceKey: string }[] }[];
}

describe('the web-scan export route (Task 8B)', () => {
  let h: WebScanAdminHarness;
  let app: FastifyInstance;
  let siteId: string;
  let scanId: string;

  beforeEach(async () => {
    h = await createWebScanAdminApp();
    app = h.app;
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname: 'example.com',
        baseUrl: 'https://example.com',
        scope: {
          crawlPaths: [],
          blockedPaths: [],
          parameterizedPaths: [],
          activePaths: [],
          extraFilePaths: [],
        },
        authorize: true,
      },
    });
    siteId = created.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    scanId = await enqueue('export-key-00001');
    await h.store.recordScanOutcome('worker', {
      scanId,
      siteId,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 55,
      findings: [{ id: 'finding-a', scanId, siteId, ...findingA }],
      coverage: [],
      updates: [{ state: 'outstanding', finding: findingA }],
    });
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  /** Queues a manual scan and answers with its id. */
  const enqueue = async (key: string): Promise<string> => {
    const queued = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { idempotencyKey: key, authorize: true },
    });
    return queued.json().scan.id as string;
  };

  const exportScan = (format: string, id = scanId) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${id}/export?format=${format}`,
      headers: { cookie: h.adminCookie },
    });

  it('sends the HTML report as an attachment with a safe name', async () => {
    const res = await exportScan('html');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="webscan-report-${scanId}.html"`,
    );
    // The name is a fixed pattern around the scan id: no hostname, no target, no secret.
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="webscan-report-[0-9a-f-]{36}\.html"$/,
    );
    expect(res.body).toContain('Website security scan report');
  });

  it('sends the machine report as an attachment with a safe name', async () => {
    const res = await exportScan('json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="webscan-report-${scanId}.json"`,
    );
    const report = JSON.parse(res.body);
    expect(report.schema).toBe('mergepilot.webscan.report');
    expect(report.site.hostname).toBe('example.com');
    expect(report.scan.status).toBe('completed');
    expect(report.groups).toHaveLength(1);
  });

  it('escapes a hostile finding in the HTML report', async () => {
    const res = await exportScan('html');
    expect(res.body).not.toContain(HOSTILE_SUBJECT);
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>alert');
  });

  it('reports the findings of its own scan and not the findings of a later one', async () => {
    // The second scan proves the first finding fixed and observes a second one.
    const secondId = await enqueue('export-key-00002');
    await h.store.recordScanOutcome('worker', {
      scanId: secondId,
      siteId,
      status: 'completed',
      requests: 4,
      pages: 1,
      durationMs: 70,
      findings: [
        { id: 'finding-a-fixed', scanId: secondId, siteId, ...findingA, comparison: 'Fixed' },
        { id: 'finding-b', scanId: secondId, siteId, ...findingB },
      ],
      coverage: [],
      updates: [
        { state: 'fixed', finding: { ...findingA, comparison: 'Fixed' } },
        { state: 'outstanding', finding: findingB },
      ],
    });

    // The report of the first scan still shows the finding it observed, and it does
    // not show the finding of the second scan.
    const first = JSON.parse((await exportScan('json', scanId)).body) as MachineReport;
    const firstKeys = first.groups.flatMap((group) =>
      group.occurrences.map((occurrence) => occurrence.occurrenceKey),
    );
    expect(firstKeys).toEqual([OCCURRENCE_A]);
    expect(JSON.stringify(first)).not.toContain(OCCURRENCE_B);

    // The report of the second scan shows both of its findings.
    const second = JSON.parse((await exportScan('json', secondId)).body) as MachineReport;
    const secondKeys = second.groups.flatMap((group) =>
      group.occurrences.map((occurrence) => occurrence.occurrenceKey),
    );
    expect(secondKeys.sort()).toEqual([OCCURRENCE_A, OCCURRENCE_B].sort());
  });

  it('refuses a format that is not html or json', async () => {
    for (const query of ['format=pdf', 'format=', 'format=HTML', 'format=json&extra=1', 'other=1']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/web-scan/scans/${scanId}/export?${query}`,
        headers: { cookie: h.adminCookie },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_request');
    }
  });

  it('answers a scan that is not there with 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${UNKNOWN_ID}/export?format=json`,
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: 'Not found' });
  });

  it('answers a scan that has not finished with 409', async () => {
    const running = await enqueue('export-key-00003');
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${running}/export?format=json`,
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });
});

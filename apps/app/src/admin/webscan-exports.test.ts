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
 */

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';
const HOSTILE_SUBJECT = '<script>alert("x")</script>';

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
    const queued = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { idempotencyKey: 'export-key-00001', authorize: true },
    });
    scanId = queued.json().scan.id as string;
    await h.store.recordScanOutcome('worker', {
      scanId,
      siteId,
      status: 'completed',
      requests: 3,
      pages: 1,
      durationMs: 55,
      findings: [],
      coverage: [],
      updates: [
        {
          state: 'outstanding',
          finding: {
            occurrenceKey: 'd'.repeat(64),
            targetKey: 'target-1',
            issueKey: 'headers|headers/strict-transport-security|example.com',
            checkId: 'headers',
            checkVersion: 1,
            issueId: 'headers/strict-transport-security',
            subject: HOSTILE_SUBJECT,
            severity: 'medium',
            validation: 'Likely',
            confidence: 'high',
            safeLocation: 'https://example.com/',
            evidenceHash: 'e'.repeat(64),
            evidence: { header: 'missing' },
            comparison: 'New',
          },
        },
      ],
    });
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  const exportScan = (format: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${scanId}/export?format=${format}`,
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
    const queued = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { idempotencyKey: 'export-key-00002', authorize: true },
    });
    const running = queued.json().scan.id as string;
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${running}/export?format=json`,
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });
});

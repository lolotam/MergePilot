import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The access rules of the scanner routes (ADR-0052 section 1).
 *
 * The scanner area is platform-admin only, so every method answers the regular 404
 * to every caller that is not a platform administrator: an anonymous caller, an
 * address of the administrator list whose email is not verified, an administrator of
 * a workspace and a member of another workspace. The live stream and the export are
 * no exceptions, and no stream header is ever sent to them.
 */

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

interface Method {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
}

describe('the access rules of the web-scan routes (Task 8B)', () => {
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
      payload: { idempotencyKey: 'access-key-00001', authorize: true },
    });
    scanId = queued.json().scan.id as string;
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  const methods = (): Method[] => [
    { name: 'enqueue a scan', method: 'POST', url: `/api/admin/web-scan/sites/${siteId}/scans` },
    { name: 'read the scan history', method: 'GET', url: `/api/admin/web-scan/sites/${siteId}/scans` },
    { name: 'read a scan', method: 'GET', url: `/api/admin/web-scan/scans/${scanId}` },
    { name: 'stop a scan', method: 'POST', url: `/api/admin/web-scan/scans/${scanId}/stop` },
    { name: 'stream the scan events', method: 'GET', url: `/api/admin/web-scan/scans/${scanId}/events` },
    {
      name: 'export the scan',
      method: 'GET',
      url: `/api/admin/web-scan/scans/${scanId}/export?format=json`,
    },
    { name: 'list the exceptions', method: 'GET', url: `/api/admin/web-scan/sites/${siteId}/exceptions` },
    {
      name: 'record an exception',
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions`,
    },
    {
      name: 'revoke an exception',
      method: 'DELETE',
      url: `/api/admin/web-scan/sites/${siteId}/exceptions/${UNKNOWN_ID}`,
    },
  ];

  const callers = (): Array<{ name: string; cookie?: string }> => [
    { name: 'an anonymous caller' },
    { name: 'an unverified administrator', cookie: h.unverifiedCookie },
    { name: 'a workspace administrator', cookie: h.workspaceAdminCookie },
    { name: 'a member of another workspace', cookie: h.regularCookie },
  ];

  it('answers the same 404 to every caller that is not a platform administrator', async () => {
    for (const caller of callers()) {
      for (const target of methods()) {
        const res = await app.inject({
          method: target.method,
          url: target.url,
          headers: caller.cookie === undefined ? {} : { cookie: caller.cookie },
          ...(target.method === 'POST'
            ? { payload: { idempotencyKey: 'access-key-00002', authorize: true } }
            : {}),
        });
        expect(`${caller.name} / ${target.name}: ${res.statusCode}`).toBe(
          `${caller.name} / ${target.name}: 404`,
        );
        // No stream header reaches a caller that is not a platform administrator.
        expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
      }
    }
  });

  it('answers the same 404 to a caller that is not a platform administrator, whatever the id', async () => {
    for (const target of [
      { method: 'GET' as const, url: `/api/admin/web-scan/scans/${UNKNOWN_ID}` },
      { method: 'POST' as const, url: `/api/admin/web-scan/scans/${UNKNOWN_ID}/stop` },
      { method: 'GET' as const, url: `/api/admin/web-scan/scans/${UNKNOWN_ID}/events` },
      { method: 'GET' as const, url: `/api/admin/web-scan/scans/${UNKNOWN_ID}/export?format=html` },
      { method: 'GET' as const, url: `/api/admin/web-scan/sites/${UNKNOWN_ID}/exceptions` },
    ]) {
      const res = await app.inject({
        method: target.method,
        url: target.url,
        headers: { cookie: h.regularCookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

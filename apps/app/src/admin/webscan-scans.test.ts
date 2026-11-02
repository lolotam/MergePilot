import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { webScanSites } from '../db/schema.js';
import { PgWebScanWorkerStore } from '../webscan/worker-store-persistence.js';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The scan routes of the scanner (ADR-0052 sections 6 and 7).
 *
 * A manual scan is an authorization act, so it needs its fresh confirmation, and it
 * is idempotent: the same key with the same data answers with the same scan, and the
 * same key with other data is a conflict. The stop is idempotent as well, and it is
 * the administrator half of the attempt fence.
 */

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

describe('the web-scan scan routes (Task 8B)', () => {
  let h: WebScanAdminHarness;
  let app: FastifyInstance;

  beforeEach(async () => {
    h = await createWebScanAdminApp();
    app = h.app;
  });

  afterEach(async () => {
    await app.close();
    await h.handle.close();
  });

  const createSite = async (hostname = 'example.com') => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname,
        baseUrl: `https://${hostname}`,
        scope: { crawlPaths: [], blockedPaths: [], parameterizedPaths: [], activePaths: [], extraFilePaths: [] },
        authorize: true,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  const enqueue = (siteId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: body,
    });

  const auditActions = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/audit',
      headers: { cookie: h.adminCookie },
    });
    return res.json().audit.map((row: { action: string }) => row.action);
  };

  const manualBody = (key = 'manual-key-0001') => ({ idempotencyKey: key, authorize: true });

  it('queues a manual scan with the fresh authorization and audits it once', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });

    const res = await enqueue(siteId, manualBody());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.replayed).toBe(false);
    expect(body.scan.status).toBe('queued');
    expect(body.scan.trigger).toBe('manual');
    expect(body.scan.siteId).toBe(siteId);
    // The internal lock and lease columns never leave the store.
    expect(body.scan.attemptId).toBeUndefined();
    expect(body.scan.idempotencyKey).toBeUndefined();
    expect(body.scan.outboxState).toBeUndefined();

    expect((await auditActions()).filter((action) => action === 'scan.enqueue')).toHaveLength(1);
  });

  it('refuses a manual scan without the authorization confirmation and queues nothing', async () => {
    const siteId = await createSite();
    const { authorize: _authorize, ...body } = manualBody();
    const res = await enqueue(siteId, body);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');

    const history = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie },
    });
    expect(history.json().scans).toEqual([]);
    expect(await auditActions()).not.toContain('scan.enqueue');
  });

  it('answers a replayed request with the same scan and queues it once', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });

    const first = await enqueue(siteId, manualBody('replay-key-0001'));
    const second = await enqueue(siteId, manualBody('replay-key-0001'));
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().scan.id).toBe(first.json().scan.id);

    const history = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie },
    });
    expect(history.json().scans).toHaveLength(1);
    expect((await auditActions()).filter((action) => action === 'scan.enqueue')).toHaveLength(1);
  });

  it('refuses the same idempotency key with different data', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });

    await enqueue(siteId, manualBody('conflict-key-001'));
    const conflict = await enqueue(siteId, {
      idempotencyKey: 'conflict-key-001',
      authorize: true,
      checks: { headers: false, cookies: true, transport: true, disclosure: true, files: true, active: false },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('conflict');
  });

  it('answers a paused scanner with 409 and queues nothing', async () => {
    const siteId = await createSite();
    const res = await enqueue(siteId, manualBody('paused-key-0001'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('paused');
  });

  it('answers a site whose authorization is gone with 409', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    await h.handle.db
      .update(webScanSites)
      .set({ authorizationAuditId: null, authorizedBy: null })
      .where(eq(webScanSites.id, siteId));

    const res = await enqueue(siteId, manualBody('unauthorized-key-1'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('authorization_required');
  });

  it('answers an id of another scope with 404', async () => {
    const siteId = await createSite();
    const unknownSite = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${UNKNOWN_ID}/scans`,
      headers: { cookie: h.adminCookie },
    });
    expect(unknownSite.statusCode).toBe(404);

    const unknownScan = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${UNKNOWN_ID}`,
      headers: { cookie: h.adminCookie },
    });
    expect(unknownScan.statusCode).toBe(404);

    const unknownStop = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/scans/${UNKNOWN_ID}/stop`,
      headers: { cookie: h.adminCookie },
    });
    expect(unknownStop.statusCode).toBe(404);
    expect(siteId).toEqual(expect.any(String));
  });

  it('pages the scan history of a site', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    await enqueue(siteId, manualBody('page-key-0001'));
    await enqueue(siteId, manualBody('page-key-0002'));

    const all = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}/scans`,
      headers: { cookie: h.adminCookie },
    });
    expect(all.json().scans).toHaveLength(2);
    expect(all.json().limit).toBe(50);
    expect(all.json().offset).toBe(0);

    const page = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/sites/${siteId}/scans?limit=1&offset=1`,
      headers: { cookie: h.adminCookie },
    });
    expect(page.json().scans).toHaveLength(1);
    expect(page.json().offset).toBe(1);
  });

  it('shows the state, the coverage and the ledger of a scan without a secret field', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    const queued = await enqueue(siteId, manualBody('detail-key-0001'));
    const scanId = queued.json().scan.id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${scanId}`,
      headers: { cookie: h.adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().scan.id).toBe(scanId);
    expect(detail.json().coverage).toEqual([]);
    expect(detail.json().occurrences).toEqual([]);

    for (const marker of ['identitykey', 'ciphertext', 'plaintext', 'secret', 'lease', 'heartbeat', 'outbox']) {
      expect(detail.body.toLowerCase().includes(marker)).toBe(false);
    }
  });

  it('stops a queued scan and answers with its terminal state', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    const queued = await enqueue(siteId, manualBody('stop-key-00001'));
    const scanId = queued.json().scan.id as string;

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/scans/${scanId}/stop`,
      headers: { cookie: h.adminCookie },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().scan.status).toBe('stopped');
    expect(stopped.json().scan.stopReason).toBe('cancelled');
    expect((await auditActions()).filter((action) => action === 'scan.stop')).toHaveLength(1);
  });

  it('stops a running scan and refuses the terminal write of its attempt', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    const queued = await enqueue(siteId, manualBody('stop-key-00002'));
    const scanId = queued.json().scan.id as string;
    const worker = new PgWebScanWorkerStore(h.handle.db);
    const attempt = { scanId, attemptId: 'attempt-of-the-admin-stop' };
    await worker.claimScan({ ...attempt, now: new Date() });

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/scans/${scanId}/stop`,
      headers: { cookie: h.adminCookie },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().scan.status).toBe('stopped');

    const live = await worker.readLiveScanState(siteId, attempt);
    expect(live?.attemptOwned).toBe(false);
  });

  it('stops a scan that already finished without changing it', async () => {
    const siteId = await createSite();
    await app.inject({
      method: 'PATCH',
      url: '/api/admin/web-scan/settings',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: { paused: false },
    });
    const queued = await enqueue(siteId, manualBody('stop-key-00003'));
    const scanId = queued.json().scan.id as string;
    await h.store.recordScanOutcome('worker', {
      scanId,
      siteId,
      status: 'completed',
      requests: 4,
      pages: 2,
      durationMs: 90,
      findings: [],
      coverage: [],
      updates: [],
    });

    const stopped = await app.inject({
      method: 'POST',
      url: `/api/admin/web-scan/scans/${scanId}/stop`,
      headers: { cookie: h.adminCookie },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().scan.status).toBe('completed');
    expect(stopped.json().scan.stopReason).toBeNull();
    expect((await auditActions()).filter((action) => action === 'scan.stop')).toHaveLength(0);
  });

  it('refuses a malformed scan id with 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/scans/not-a-uuid',
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_request');
  });
});

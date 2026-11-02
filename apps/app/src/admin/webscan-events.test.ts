import http from 'node:http';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eventually, listen } from '../api/runs-events.fixtures.js';
import { WebScanErrorBodySchema } from '../api/contract-webscan.js';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The live progress stream of a scan (ADR-0052 section 7).
 *
 * The guard runs before any header, so a caller that is not a platform administrator
 * never receives a stream header. The stream carries the events of one scan only, it
 * ends when the browser goes, and it ends when the session stops being a platform
 * administrator: the role is re-checked with the keep-alive.
 */

interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => string;
  waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
}

/** Opens a real SSE connection: an injected request cannot read a stream that never ends. */
function openScanStream(port: number, path: string, cookie: string): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { cookie, accept: 'text/event-stream' } },
      (res) => {
        let received = '';
        const waiters: Array<() => void> = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += chunk;
          for (const waiter of [...waiters]) waiter();
        });
        res.on('error', () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => received,
          waitFor: (predicate, timeoutMs = 3_000) =>
            new Promise((ok, fail) => {
              const check = () => {
                if (!predicate(received)) return;
                clearTimeout(timer);
                waiters.splice(waiters.indexOf(check), 1);
                ok(received);
              };
              const timer = setTimeout(
                () => fail(new Error(`stream timed out; got: ${received}`)),
                timeoutMs,
              );
              waiters.push(check);
              check();
            }),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
  });
}

/** Registers a site and queues a scan of it in the given harness. */
async function seedScan(h: WebScanAdminHarness): Promise<{ siteId: string; scanId: string }> {
  const created = await h.app.inject({
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
  const siteId = created.json().id as string;
  await h.app.inject({
    method: 'PATCH',
    url: '/api/admin/web-scan/settings',
    headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
    payload: { paused: false },
  });
  const queued = await h.app.inject({
    method: 'POST',
    url: `/api/admin/web-scan/sites/${siteId}/scans`,
    headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
    payload: { idempotencyKey: 'events-key-00001', authorize: true },
  });
  return { siteId, scanId: queued.json().scan.id as string };
}

describe('the web-scan live events route (Task 8B)', () => {
  let h: WebScanAdminHarness;
  let port: number;
  let siteId: string;
  let scanId: string;
  let otherScanId: string;

  beforeEach(async () => {
    h = await createWebScanAdminApp({ streams: { perUser: 2, global: 10, keepAliveMs: 60 } });
    const seeded = await seedScan(h);
    siteId = seeded.siteId;
    scanId = seeded.scanId;
    const queue = async (key: string) => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/admin/web-scan/sites/${siteId}/scans`,
        headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
        payload: { idempotencyKey: key, authorize: true },
      });
      return res.json().scan.id as string;
    };
    otherScanId = await queue('events-key-00002');
    port = await listen(h.app);
  }, 30_000);

  afterEach(async () => {
    await h.app.close();
    await h.handle.close();
  });

  it('answers 404 to an anonymous caller and sends no stream header', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/scans/${scanId}/events`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
    expect(h.events.listenerCount(siteId)).toBe(0);
  });

  it('streams the events of its own scan only', async () => {
    const stream = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${scanId}/events`,
      h.adminCookie,
    );
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toContain('text/event-stream');
      expect(stream.headers['cache-control']).toContain('no-cache');
      expect(stream.headers['x-accel-buffering']).toBe('no');
      await stream.waitFor((text) => text.includes(': connected'));
      expect(stream.text()).toContain('retry: 5000');

      h.events.publish({
        scanId: otherScanId,
        siteId,
        kind: 'progress',
        status: 'running',
        requests: 9,
        pages: 3,
        elapsedMs: 500,
      });
      h.events.publish({
        scanId,
        siteId,
        kind: 'progress',
        status: 'running',
        requests: 1,
        pages: 1,
        elapsedMs: 10,
      });

      const text = await stream.waitFor((received) => received.includes(`"scanId":"${scanId}"`));
      expect(text).toContain('event: scan');
      expect(text).not.toContain(otherScanId);
    } finally {
      stream.close();
    }
  });

  it('sends a keep-alive comment and no target, no query and no reason', async () => {
    const stream = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${scanId}/events`,
      h.adminCookie,
    );
    try {
      await stream.waitFor((text) => text.includes(': keep-alive\n\n'));
      h.events.publish({
        scanId,
        siteId,
        kind: 'progress',
        status: 'running',
        requests: 2,
        pages: 1,
        elapsedMs: 20,
      });
      const text = await stream.waitFor((received) => received.includes('"requests":2'));
      expect(text).not.toContain('example.com');
      expect(text).not.toContain('https://');
      expect(text).not.toContain('?');
    } finally {
      stream.close();
    }
  });

  it('closes the subscription when the browser goes', async () => {
    const stream = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${scanId}/events`,
      h.adminCookie,
    );
    await stream.waitFor((text) => text.includes(': connected'));
    expect(h.events.listenerCount(siteId)).toBe(1);

    stream.close();
    await eventually(() => h.events.listenerCount(siteId) === 0);
  });

  it('ends the stream when the session stops being a platform administrator', async () => {
    const stream = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${scanId}/events`,
      h.adminCookie,
    );
    try {
      await stream.waitFor((text) => text.includes(': connected'));
      expect(h.events.listenerCount(siteId)).toBe(1);

      // The email of the administrator is no longer verified, so the re-check of the
      // keep-alive ends the stream.
      await h.handle.db.execute(
        `UPDATE "user" SET "emailVerified" = false WHERE id = 'u-admin'`,
      );

      await eventually(() => h.events.listenerCount(siteId) === 0, 5_000);
    } finally {
      stream.close();
    }
  });

  it('answers 429 when the caller has too many open streams', async () => {
    const first = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${scanId}/events`,
      h.adminCookie,
    );
    const second = await openScanStream(
      port,
      `/api/admin/web-scan/scans/${otherScanId}/events`,
      h.adminCookie,
    );
    try {
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const third = await h.app.inject({
        method: 'GET',
        url: `/api/admin/web-scan/scans/${scanId}/events`,
        headers: { cookie: h.adminCookie },
      });
      expect(third.statusCode).toBe(429);
      // The body of the route is a body of the scanner contract.
      expect(WebScanErrorBodySchema.parse(third.json()).error.code).toBe('too_many_streams');
      expect(third.json()).toEqual({
        error: { code: 'too_many_streams', message: 'Too many open live streams for this user' },
      });
    } finally {
      first.close();
      second.close();
    }
  });

  it('answers 503 when the live updates are not available', async () => {
    const failing = await createWebScanAdminApp({ failingEvents: true });
    try {
      const seeded = await seedScan(failing);
      const res = await failing.app.inject({
        method: 'GET',
        url: `/api/admin/web-scan/scans/${seeded.scanId}/events`,
        headers: { cookie: failing.adminCookie },
      });
      expect(res.statusCode).toBe(503);
      // The body of the route is a body of the scanner contract.
      expect(WebScanErrorBodySchema.parse(res.json()).error.code).toBe('live_updates_unavailable');
      expect(res.json()).toEqual({
        error: { code: 'live_updates_unavailable', message: 'Live updates are not available' },
      });
    } finally {
      await failing.app.close();
      await failing.handle.close();
    }
  });

  it('answers 404 for a scan that is not there', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/admin/web-scan/scans/11111111-1111-4111-8111-111111111111/events',
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(h.events.listenerCount(siteId)).toBe(0);
  });
});

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWebScanAdminApp, type WebScanAdminHarness } from './webscan.fixtures.js';

/**
 * The pages of the audit log (ADR-0052 section 10).
 *
 * The route asks the store for the page it needs and the total of the log in one
 * call, so a deep offset returns the rows of that page and the total stays the
 * number of the rows of the same log.
 */

describe('the audit log route (Task 8B)', () => {
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

  const page = async (query: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/web-scan/audit${query}`,
      headers: { cookie: h.adminCookie },
    });

  /** Registers a site, which writes its own audit rows. */
  const createSite = async (hostname: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/web-scan/sites',
      headers: { cookie: h.adminCookie, 'content-type': 'application/json' },
      payload: {
        hostname,
        baseUrl: `https://${hostname}`,
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
    expect(created.statusCode).toBe(201);
  };

  it('reads the page that was asked for and counts the log', async () => {
    for (const hostname of ['a.example.com', 'b.example.com', 'c.example.com']) {
      await createSite(hostname);
    }

    const all = await page('');
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(6);
    expect(all.json().audit).toHaveLength(6);

    const first = await page('?limit=2&offset=0');
    const second = await page('?limit=2&offset=2');
    const third = await page('?limit=2&offset=4');
    expect(first.json().audit).toHaveLength(2);
    expect(second.json().audit).toHaveLength(2);
    expect(third.json().audit).toHaveLength(2);

    // The pages hold every row of the log exactly once.
    const ids = [...first.json().audit, ...second.json().audit, ...third.json().audit].map(
      (row: { id: string }) => row.id,
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);

    // The total is the number of rows of the log on every page.
    expect(second.json().total).toBe(6);
    expect(third.json().total).toBe(6);

    // An offset past the end of the log is an empty page with the same total.
    const beyond = await page('?limit=2&offset=100');
    expect(beyond.statusCode).toBe(200);
    expect(beyond.json().audit).toEqual([]);
    expect(beyond.json().total).toBe(6);
  });

  it('lets the store read the page instead of reading it and slicing it', async () => {
    await createSite('a.example.com');
    const listAuditPage = vi.spyOn(h.store, 'listAuditPage');

    await page('?limit=2&offset=4');

    // The offset reaches the store as it was asked for.
    expect(listAuditPage).toHaveBeenCalledWith({ limit: 2, offset: 4 });
  });

  it('reads the page and the total of the log in one call', async () => {
    await createSite('a.example.com');
    const listAuditPage = vi.spyOn(h.store, 'listAuditPage');
    const listAudit = vi.spyOn(h.store, 'listAudit');
    const countAudit = vi.spyOn(h.store, 'countAudit');

    const response = await page('?limit=1&offset=0');

    expect(response.statusCode).toBe(200);
    // The page and the total come from one snapshot of the log, so the route never
    // reads the log twice.
    expect(listAuditPage).toHaveBeenCalledTimes(1);
    expect(listAudit).not.toHaveBeenCalled();
    expect(countAudit).not.toHaveBeenCalled();
  });

  it('never answers a page that holds more rows than the log has', async () => {
    for (const hostname of ['a.example.com', 'b.example.com', 'c.example.com']) {
      await createSite(hostname);
    }

    const first = await page('?limit=2&offset=0');
    const beyond = await page('?limit=2&offset=100');

    // The page of the log and its total describe the same log.
    expect(first.json().audit.length).toBeLessThanOrEqual(first.json().total);
    // An offset past the end of the log is an empty page that still knows the total.
    expect(beyond.json().audit).toEqual([]);
    expect(beyond.json().total).toBe(6);
  });
});

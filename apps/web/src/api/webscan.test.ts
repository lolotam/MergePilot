import { afterEach, describe, expect, it } from 'vitest';
import { downloadScanExport, webScanApi } from './webscan.js';
import {
  attachmentResponse,
  exceptionFixture,
  exceptionsPageFixture,
  installFetch,
  jsonResponse,
  scanDetailFixture,
  scanFixture,
  scansPageFixture,
  settingsFixture,
  siteFixture,
} from '../admin/webscan/webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('the website scan API client', () => {
  it('reads the global policy', async () => {
    const calls = installFetch(() => jsonResponse(settingsFixture));

    const settings = await webScanApi.getSettings();

    expect(settings).toEqual(settingsFixture);
    expect(calls[0]?.url).toBe('/api/admin/web-scan/settings');
    expect(calls[0]?.method).toBe('GET');
  });

  it('patches the global policy with the changed fields only', async () => {
    const calls = installFetch(() => jsonResponse(settingsFixture));

    await webScanApi.updateSettings({ paused: true });

    expect(calls[0]?.url).toBe('/api/admin/web-scan/settings');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.body).toEqual({ paused: true });
  });

  it('reads a page of the sites', async () => {
    const calls = installFetch(() => jsonResponse({ sites: [], total: 0, limit: 25, offset: 0 }));

    await webScanApi.getSites({ limit: 25, offset: 0 });

    expect(calls[0]?.url).toBe('/api/admin/web-scan/sites?limit=25&offset=0');
    expect(calls[0]?.method).toBe('GET');
  });

  it('registers a site with its authorization', async () => {
    const calls = installFetch(() => jsonResponse(siteFixture, 201));

    const created = await webScanApi.createSite({
      hostname: 'example.com',
      baseUrl: 'https://example.com',
      scope: {
        crawlPaths: [],
        blockedPaths: [],
        parameterizedPaths: [],
        activePaths: [],
        extraFilePaths: [],
      },
      schedule: null,
      authorize: true,
    });

    expect(created).toEqual(siteFixture);
    expect(calls[0]?.url).toBe('/api/admin/web-scan/sites');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({ hostname: 'example.com', authorize: true });
  });

  it('updates a site with its authorization', async () => {
    const calls = installFetch(() => jsonResponse(siteFixture));

    await webScanApi.updateSite(siteFixture.id, { authorize: true });

    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}`);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.body).toEqual({ authorize: true });
  });

  it('removes a site', async () => {
    const calls = installFetch(() => jsonResponse({ ...siteFixture, removedAt: '2026-11-02T00:00:00.000Z' }));

    await webScanApi.deleteSite(siteFixture.id);

    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}`);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('answers a refused request with the error of the server', async () => {
    installFetch(() =>
      jsonResponse({ error: { code: 'confirmation_required', message: 'A value above its default' } }, 422),
    );

    await expect(webScanApi.updateSettings({ paused: true })).rejects.toMatchObject({
      code: 'confirmation_required',
      status: 422,
    });
  });

  it('starts a manual scan with its idempotency key', async () => {
    const calls = installFetch(() => jsonResponse({ scan: scanFixture, replayed: false }, 201));

    const result = await webScanApi.startManualScan(siteFixture.id, {
      idempotencyKey: 'manual-12345678',
      authorize: true,
    });

    expect(result.scan).toEqual(scanFixture);
    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}/scans`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ idempotencyKey: 'manual-12345678', authorize: true });
  });

  it('reads a page of the scan history of a site', async () => {
    const calls = installFetch(() => jsonResponse(scansPageFixture));

    const page = await webScanApi.getScans(siteFixture.id, { limit: 20, offset: 0 });

    expect(page.scans).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}/scans?limit=20&offset=0`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('reads the state of a scan', async () => {
    const calls = installFetch(() => jsonResponse(scanDetailFixture));

    const detail = await webScanApi.getScan(scanFixture.id);

    expect(detail.scan.id).toBe(scanFixture.id);
    expect(calls[0]?.url).toBe(`/api/admin/web-scan/scans/${scanFixture.id}`);
  });

  it('stops a scan', async () => {
    const calls = installFetch(() => jsonResponse({ scan: scanFixture }));

    await webScanApi.stopScan(scanFixture.id);

    expect(calls[0]?.url).toBe(`/api/admin/web-scan/scans/${scanFixture.id}/stop`);
    expect(calls[0]?.method).toBe('POST');
  });

  it('reads the exceptions of a site', async () => {
    const calls = installFetch(() => jsonResponse(exceptionsPageFixture));

    const page = await webScanApi.getExceptions(siteFixture.id);

    expect(page.exceptions).toHaveLength(1);
    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}/exceptions`);
  });

  it('adds an exception', async () => {
    const calls = installFetch(() => jsonResponse(exceptionFixture, 201));

    await webScanApi.createException(siteFixture.id, {
      occurrenceKey: exceptionFixture.occurrenceKey,
      evidenceHash: exceptionFixture.evidenceHash,
      kind: 'accepted',
      reasonCategory: 'accepted_risk',
      reason: 'The gateway owns the header.',
      expiresAt: null,
    });

    expect(calls[0]?.url).toBe(`/api/admin/web-scan/sites/${siteFixture.id}/exceptions`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({ kind: 'accepted', reasonCategory: 'accepted_risk' });
  });

  it('revokes an exception', async () => {
    const calls = installFetch(() => jsonResponse(exceptionFixture));

    await webScanApi.deleteException(siteFixture.id, exceptionFixture.id);

    expect(calls[0]?.url).toBe(
      `/api/admin/web-scan/sites/${siteFixture.id}/exceptions/${exceptionFixture.id}`,
    );
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('reads a page of the audit log', async () => {
    const calls = installFetch(() => jsonResponse({ audit: [], limit: 25, offset: 0 }));

    await webScanApi.getAudit({ limit: 25, offset: 0 });

    expect(calls[0]?.url).toBe('/api/admin/web-scan/audit?limit=25&offset=0');
    expect(calls[0]?.method).toBe('GET');
  });

  it('downloads the report of a scan with the name of the server', async () => {
    const calls = installFetch(() => attachmentResponse(`webscan-report-${scanFixture.id}.json`));

    const report = await downloadScanExport(scanFixture.id, 'json');

    expect(report.filename).toBe(`webscan-report-${scanFixture.id}.json`);
    expect(calls[0]?.url).toBe(`/api/admin/web-scan/scans/${scanFixture.id}/export?format=json`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('fails the download when the server refuses the export', async () => {
    installFetch(() =>
      jsonResponse({ error: { code: 'conflict', message: 'The scan has no report yet' } }, 409),
    );

    await expect(downloadScanExport(scanFixture.id, 'html')).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { webScanApi } from './webscan.js';
import { installFetch, jsonResponse, settingsFixture, siteFixture } from '../admin/webscan/webscan-test-utils.js';

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
});

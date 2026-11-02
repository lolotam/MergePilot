import type {
  WebScanCreateSiteRequest,
  WebScanSettingsDto,
  WebScanSettingsPatchRequest,
  WebScanSiteDto,
  WebScanSitesPage,
  WebScanUpdateSiteRequest,
} from '@mergepilot/app/contract';
import { fetchApi } from './client.js';

/**
 * The platform-admin website security scan API (ADR-0052 section 5).
 *
 * Every route answers the regular 404 to anyone who is not a platform admin, so
 * a 404 from here means the session lost its admin rights, never that a row is
 * missing. The wire shapes come from `@mergepilot/app/contract`; this file only
 * wraps them, so the dashboard and the server cannot drift apart.
 */

const WEB_SCAN_PATH = '/api/admin/web-scan';

/** The offset page of the sites list. */
export interface WebScanSitesQuery {
  limit?: number | undefined;
  offset?: number | undefined;
}

function sitesQueryString(query: WebScanSitesQuery | undefined): string {
  const search = new URLSearchParams();
  if (query?.limit !== undefined) search.set('limit', String(query.limit));
  if (query?.offset !== undefined) search.set('offset', String(query.offset));
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const webScanApi = {
  /** GET /api/admin/web-scan/settings — the effective global policy. */
  getSettings: () => fetchApi<WebScanSettingsDto>(`${WEB_SCAN_PATH}/settings`),
  /** PATCH /api/admin/web-scan/settings — only the changed fields are sent. */
  updateSettings: (patch: WebScanSettingsPatchRequest) =>
    fetchApi<WebScanSettingsDto>(`${WEB_SCAN_PATH}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** GET /api/admin/web-scan/sites — an offset page of the registered sites. */
  getSites: (query?: WebScanSitesQuery) =>
    fetchApi<WebScanSitesPage>(`${WEB_SCAN_PATH}/sites${sitesQueryString(query)}`),
  /** POST /api/admin/web-scan/sites — a registration carries `authorize: true`. */
  createSite: (body: WebScanCreateSiteRequest) =>
    fetchApi<WebScanSiteDto>(`${WEB_SCAN_PATH}/sites`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** PATCH /api/admin/web-scan/sites/:siteId — a scope or schedule change needs `authorize: true`. */
  updateSite: (siteId: string, body: WebScanUpdateSiteRequest) =>
    fetchApi<WebScanSiteDto>(`${WEB_SCAN_PATH}/sites/${encodeURIComponent(siteId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** DELETE /api/admin/web-scan/sites/:siteId — the store's soft removal. */
  deleteSite: (siteId: string) =>
    fetchApi<WebScanSiteDto>(`${WEB_SCAN_PATH}/sites/${encodeURIComponent(siteId)}`, {
      method: 'DELETE',
    }),
};

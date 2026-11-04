import type {
  WebScanAuditPage,
  WebScanCreateExceptionRequest,
  WebScanCreateSiteRequest,
  WebScanEnqueueManualRequest,
  WebScanEnqueueResult,
  WebScanExceptionDto,
  WebScanExceptionsPage,
  WebScanScanDetail,
  WebScanScansPage,
  WebScanSettingsDto,
  WebScanSettingsPatchRequest,
  WebScanSiteDto,
  WebScanSitesPage,
  WebScanStopResult,
  WebScanUpdateSiteRequest,
} from '@mergepilot/app/contract';
import { ApiClientError, fetchApi } from './client.js';

/**
 * The platform-admin website security scan API (ADR-0052 section 5).
 *
 * Every route answers the regular 404 to anyone who is not a platform admin, so
 * a 404 from here means the session lost its admin rights, never that a row is
 * missing. The wire shapes come from `@mergepilot/app/contract`; this file only
 * wraps them, so the dashboard and the server cannot drift apart.
 */

const WEB_SCAN_PATH = '/api/admin/web-scan';

/** The offset page of a list of the area. */
export interface WebScanPageQuery {
  limit?: number | undefined;
  offset?: number | undefined;
}

function pageQueryString(query: WebScanPageQuery | undefined): string {
  const search = new URLSearchParams();
  if (query?.limit !== undefined) search.set('limit', String(query.limit));
  if (query?.offset !== undefined) search.set('offset', String(query.offset));
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function sitePath(siteId: string, suffix = ''): string {
  return `${WEB_SCAN_PATH}/sites/${encodeURIComponent(siteId)}${suffix}`;
}

function scanPath(scanId: string, suffix = ''): string {
  return `${WEB_SCAN_PATH}/scans/${encodeURIComponent(scanId)}${suffix}`;
}

/**
 * The error of a reply that is not an attachment.
 *
 * The export answers a file, not a JSON body, so its failure is read here and
 * never reaches the dashboard as a body: the panels show their own message.
 */
async function toExportError(res: Response): Promise<ApiClientError> {
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } };
    if (data?.error?.code) {
      return new ApiClientError(data.error.message ?? 'The export failed', data.error.code, res.status);
    }
  } catch {
    // The reply is not a JSON body: the status is all there is.
  }
  return new ApiClientError('The export failed', 'UNKNOWN', res.status);
}

/**
 * GET /api/admin/web-scan/scans/:scanId/export — the report as an attachment.
 *
 * The file name comes from the server's `Content-Disposition`, never from the
 * scan: the server builds it around the scan id alone.
 */
export async function downloadScanExport(
  scanId: string,
  format: 'html' | 'json',
): Promise<{ filename: string; blob: Blob }> {
  const res = await fetch(`${scanPath(scanId)}/export?format=${format}`, {
    credentials: 'include',
  });
  if (!res.ok) throw await toExportError(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `webscan-report.${format}`;
  return { filename, blob: await res.blob() };
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
  getSites: (query?: WebScanPageQuery) =>
    fetchApi<WebScanSitesPage>(`${WEB_SCAN_PATH}/sites${pageQueryString(query)}`),
  /** POST /api/admin/web-scan/sites — a registration carries `authorize: true`. */
  createSite: (body: WebScanCreateSiteRequest) =>
    fetchApi<WebScanSiteDto>(`${WEB_SCAN_PATH}/sites`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** PATCH /api/admin/web-scan/sites/:siteId — a scope or schedule change needs `authorize: true`. */
  updateSite: (siteId: string, body: WebScanUpdateSiteRequest) =>
    fetchApi<WebScanSiteDto>(sitePath(siteId), {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** DELETE /api/admin/web-scan/sites/:siteId — the store's soft removal. */
  deleteSite: (siteId: string) =>
    fetchApi<WebScanSiteDto>(sitePath(siteId), {
      method: 'DELETE',
    }),
  /** POST /api/admin/web-scan/sites/:siteId/scans — a manual scan with its idempotency key. */
  startManualScan: (siteId: string, body: WebScanEnqueueManualRequest) =>
    fetchApi<WebScanEnqueueResult>(sitePath(siteId, '/scans'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** GET /api/admin/web-scan/sites/:siteId/scans — an offset page of the scan history. */
  getScans: (siteId: string, query?: WebScanPageQuery) =>
    fetchApi<WebScanScansPage>(sitePath(siteId, `/scans${pageQueryString(query)}`)),
  /** GET /api/admin/web-scan/scans/:scanId — the state, the coverage and the ledger. */
  getScan: (scanId: string) => fetchApi<WebScanScanDetail>(scanPath(scanId)),
  /** POST /api/admin/web-scan/scans/:scanId/stop — the idempotent cancellation. */
  stopScan: (scanId: string) =>
    fetchApi<WebScanStopResult>(scanPath(scanId, '/stop'), {
      method: 'POST',
    }),
  /** GET /api/admin/web-scan/sites/:siteId/exceptions — every resolution of the site. */
  getExceptions: (siteId: string) =>
    fetchApi<WebScanExceptionsPage>(sitePath(siteId, '/exceptions')),
  /** POST /api/admin/web-scan/sites/:siteId/exceptions — a resolution of an occurrence. */
  createException: (siteId: string, body: WebScanCreateExceptionRequest) =>
    fetchApi<WebScanExceptionDto>(sitePath(siteId, '/exceptions'), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** DELETE /api/admin/web-scan/sites/:siteId/exceptions/:exceptionId — the revocation. */
  deleteException: (siteId: string, exceptionId: string) =>
    fetchApi<WebScanExceptionDto>(
      sitePath(siteId, `/exceptions/${encodeURIComponent(exceptionId)}`),
      { method: 'DELETE' },
    ),
  /** GET /api/admin/web-scan/audit — an offset page of the immutable history. */
  getAudit: (query?: WebScanPageQuery) =>
    fetchApi<WebScanAuditPage>(`${WEB_SCAN_PATH}/audit${pageQueryString(query)}`),
};

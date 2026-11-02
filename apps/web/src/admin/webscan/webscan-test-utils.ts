import { vi } from 'vitest';
import type { WebScanSettingsDto, WebScanSiteDto, WebScanSitesPage } from '@mergepilot/app/contract';

/**
 * The test helpers of the website scan panels.
 *
 * The tests mock the HTTP boundary and nothing else: the real client, the
 * real React Query hooks and the real panels run behind it.
 */

/** A JSON answer of the mocked HTTP boundary. */
export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

/** One recorded call of the mocked HTTP boundary. */
export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Replaces the HTTP boundary with a recorder and the given answers. */
export function installFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return calls;
}

/** The global policy of the test fixtures. */
export const settingsFixture: WebScanSettingsDto = {
  paused: false,
  alertsEnabled: true,
  limits: {
    maxRequests: 500,
    maxPages: 100,
    maxActiveLinks: 30,
    requestsPerSecond: 2,
    requestTimeoutMs: 10000,
    maxResponseBytes: 1048576,
    totalTimeoutMs: 1200000,
  },
  checks: {
    headers: true,
    cookies: true,
    transport: true,
    disclosure: true,
    files: true,
    active: false,
  },
  defaultSchedule: { frequency: 'weekly', weekday: 5, hour: 4, minute: 0, enabled: false },
  retentionDays: 30,
  contact: 'security@example.com',
  alertMinSeverity: 'high',
  alertMinValidation: 'Likely',
  approvedInstallations: [{ adminUserId: 'u-admin', installationId: 101, githubAccountId: 55 }],
  updatedAt: '2026-11-01T00:00:00.000Z',
  updatedBy: 'u-admin',
};

/** One registered site of the test fixtures. */
export const siteFixture: WebScanSiteDto = {
  id: '11111111-1111-4111-8111-111111111111',
  hostname: 'example.com',
  baseUrl: 'https://example.com',
  ownerUserId: 'u-admin',
  repository: null,
  scope: {
    hostname: 'example.com',
    baseUrl: 'https://example.com',
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  },
  schedule: null,
  authorization: { auditId: null, authorizedBy: null, authorizedAt: null, scopeVersion: 0 },
  alertEpisodes: [],
  lastCoverage: null,
  lastCoverageScanId: null,
  lastCoverageAt: null,
  nextRunAt: null,
  lastScanAt: null,
  removedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

/** A site that carries its own schedule. */
export const siteWithScheduleFixture: WebScanSiteDto = {
  ...siteFixture,
  id: '22222222-2222-4222-8222-222222222222',
  hostname: 'scheduled.example.com',
  baseUrl: 'https://scheduled.example.com',
  schedule: { frequency: 'daily', hour: 3, minute: 30, enabled: true },
};

/** The page of the sites list of the test fixtures. */
export const sitesPageFixture: WebScanSitesPage = {
  sites: [siteFixture, siteWithScheduleFixture],
  total: 2,
  limit: 25,
  offset: 0,
};

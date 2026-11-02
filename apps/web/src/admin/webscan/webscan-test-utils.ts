import { vi } from 'vitest';
import type {
  WebScanAuditPage,
  WebScanExceptionDto,
  WebScanExceptionsPage,
  WebScanOccurrenceDto,
  WebScanScanDetail,
  WebScanScanDto,
  WebScanScansPage,
  WebScanSettingsDto,
  WebScanSiteDto,
  WebScanSitesPage,
} from '@mergepilot/app/contract';

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

/** The attachment answer of the export: a file with the name of the server. */
export function attachmentResponse(filename: string, contentType = 'text/html'): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : contentType,
    },
    blob: async () => ({ size: 12, type: contentType }) as unknown as Blob,
    json: async () => '',
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

/** A site whose ledger of the findings is known. */
export const siteWithScanFixture: WebScanSiteDto = {
  ...siteFixture,
  lastCoverageScanId: '33333333-3333-4333-8333-333333333333',
};

/** The page of the sites list of the test fixtures. */
export const sitesPageFixture: WebScanSitesPage = {
  sites: [siteFixture, siteWithScheduleFixture],
  total: 2,
  limit: 25,
  offset: 0,
};

/** One scan of the test fixtures. */
export const scanFixture: WebScanScanDto = {
  id: '33333333-3333-4333-8333-333333333333',
  siteId: siteFixture.id,
  trigger: 'manual',
  status: 'running',
  scheduledFor: null,
  requests: 12,
  pages: 4,
  durationMs: 8000,
  stopReason: null,
  failReason: null,
  coverageSummary: null,
  authorizationAuditId: 'audit-1',
  scopeVersion: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  startedAt: '2026-11-01T10:00:05.000Z',
  finishedAt: null,
};

/** One occurrence of the ledger of the test fixtures. */
export const occurrenceFixture: WebScanOccurrenceDto = {
  id: '44444444-4444-4444-8444-444444444444',
  occurrenceKey: 'a'.repeat(64),
  targetKey: 'target-1',
  issueKey: 'headers:missing-hsts',
  checkId: 'headers',
  checkVersion: 1,
  issueId: 'missing-hsts',
  subject: 'strict-transport-security',
  severity: 'high',
  validation: 'Confirmed',
  confidence: 'high',
  safeLocation: 'https://example.com/',
  evidenceHash: 'b'.repeat(64),
  evidence: { header: 'strict-transport-security' },
  state: 'outstanding',
  archiveReason: null,
  comparison: 'New',
  exceptionId: null,
  lastObservedAt: '2026-11-01T10:00:09.000Z',
  createdAt: '2026-11-01T10:00:09.000Z',
  updatedAt: '2026-11-01T10:00:09.000Z',
};

/** The state of the scan of the test fixtures, with its ledger. */
export const scanDetailFixture: WebScanScanDetail = {
  scan: scanFixture,
  coverage: [
    {
      targetKey: 'target-1',
      checkId: 'headers',
      checkVersion: 1,
      evaluatedIssueIds: ['missing-hsts'],
      outcome: 'checked',
      reason: null,
    },
  ],
  occurrences: [occurrenceFixture],
};

/** The page of the scan history of the test fixtures. */
export const scansPageFixture: WebScanScansPage = {
  scans: [scanFixture],
  limit: 20,
  offset: 0,
};

/** One resolution of the test fixtures. */
export const exceptionFixture: WebScanExceptionDto = {
  id: '55555555-5555-4555-8555-555555555555',
  siteId: siteFixture.id,
  occurrenceKey: 'c'.repeat(64),
  evidenceHash: 'd'.repeat(64),
  kind: 'accepted',
  reasonCategory: 'accepted_risk',
  reason: 'The site is behind a gateway that owns the header.',
  // The end date is far away on purpose: a rule that ends in the past would
  // turn into an expired one and the tests would depend on the day they run.
  expiresAt: '2099-12-31T00:00:00.000Z',
  createdBy: 'u-admin',
  createdAt: '2026-11-01T10:00:00.000Z',
  revokedAt: null,
  revokedBy: null,
};

/** The resolutions of the site of the test fixtures. */
export const exceptionsPageFixture: WebScanExceptionsPage = {
  exceptions: [exceptionFixture],
};

/** The audit log of the test fixtures. */
export const auditPageFixture: WebScanAuditPage = {
  audit: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      actor: 'u-admin',
      action: 'scan.started',
      targetType: 'site',
      targetId: siteFixture.id,
      before: null,
      after: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    },
  ],
  total: 1,
  limit: 25,
  offset: 0,
};

/**
 * The stream of the scan, as the browser sees it.
 *
 * The tests drive the events themselves: the panel reads the state of the scan
 * from the server and the counters from the stream, and the two are checked
 * apart.
 */
export class FakeEventSource {
  /** Every stream the panel opened. */
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  /** Sends one event of the stream. */
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Opens the stream, as a first connect or a reconnect does. */
  open(): void {
    this.onopen?.();
  }

  /** Drops the stream. */
  fail(): void {
    this.onerror?.();
  }
}

import { vi } from 'vitest';
import type { Pool } from 'pg';
import type { ScanDependencies, ScanObservation } from '@mergepilot/webscan';
import type { WebScanStore } from './store.js';
import type { WebScanScan, WebScanSite } from './types.js';
import type { WebScanWorkerStore } from './worker-store.js';
import type { WebScanWorkerDeps } from './worker.js';

/**
 * The shared fixtures of the scan worker tests.
 *
 * The tests of the worker are split over several files, so the fixtures they need live
 * here instead of in one of the test files.
 */

/** The settings the scan was queued with. */
export const effectiveSettings = {
  scope: {
    hostname: 'example.com',
    baseUrl: 'https://example.com',
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  },
  limits: {
    maxRequests: 10,
    maxPages: 2,
    maxActiveLinks: 5,
    requestsPerSecond: 1,
    requestTimeoutMs: 1000,
    maxResponseBytes: 1024,
    totalTimeoutMs: 60_000,
  },
  checks: {},
  contact: 'security@example.com',
};

/** A queued scan of the fixture. */
export const scan: WebScanScan = {
  id: 'scan-1',
  siteId: 'site-1',
  trigger: 'scheduled',
  status: 'queued',
  scheduledFor: new Date('2026-01-02T01:00:00.000Z'),
  idempotencyKey: null,
  requestFingerprint: null,
  attemptId: null,
  heartbeatAt: null,
  startedAt: null,
  finishedAt: null,
  requests: 0,
  pages: 0,
  durationMs: 0,
  outboxState: 'published',
  outboxPublishedAt: null,
  effectiveSettings,
  authorizationAuditId: 'audit-1',
  scopeVersion: 1,
  coverageSummary: [],
  stopReason: null,
  failReason: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
} as unknown as WebScanScan;

/** The site of the fixture. */
export const site = {
  id: 'site-1',
  hostname: 'example.com',
  baseUrl: 'https://example.com',
  scope: { hostname: 'example.com', baseUrl: 'https://example.com' },
  overrides: { hostname: 'example.com', baseUrl: 'https://example.com' },
  removedAt: null,
  scopeVersion: 1,
  authorization: {
    authorizedBy: 'admin-1',
    auditId: 'audit-1',
    scopeVersion: 1,
    approvedInstallationId: 1,
  },
} as unknown as WebScanSite;

/** The observation of a finished run. */
export const observation: ScanObservation = {
  status: 'completed',
  reason: null,
  requests: 3,
  pages: 1,
  durationMs: 120,
  coverage: [],
  findings: [],
} as unknown as ScanObservation;

/** A pool whose advisory lock is always free. */
export function fakePool(): Pool {
  const client = {
    query: async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      return { rows: [] };
    },
    on: () => client,
    removeListener: () => client,
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

/** The harness of the worker tests. */
export interface Harness {
  deps: WebScanWorkerDeps;
  runScan: ReturnType<typeof vi.fn>;
  claimScan: ReturnType<typeof vi.fn>;
  stopQueuedScan: ReturnType<typeof vi.fn>;
  recordScanOutcomeAttempt: ReturnType<typeof vi.fn>;
  readLiveScanState: ReturnType<typeof vi.fn>;
}

/** The options of the harness. */
export interface HarnessOptions {
  scan?: WebScanScan | null;
  paused?: boolean;
  administrator?: { id: string; email: string; emailVerified: boolean } | null;
  liveState?: {
    paused: boolean;
    administrator: { id: string; email: string; emailVerified: boolean } | null;
    removed: boolean;
    authorized: boolean;
    scopeVersion?: number;
    authorizingAdministrator?:
      | { id: string; email: string; emailVerified: boolean }
      | null
      | undefined;
    attemptOwned?: boolean;
  };
  platformAdmins?: string[];
  claimResult?: WebScanScan | null;
  identityKey?: string | null;
  /** The scope version the site carries now. */
  siteScopeVersion?: number;
  /** The audit rows of the site. */
  audit?: { id: string; after: unknown; action?: string }[];
}

/** Builds the dependencies of the worker over fakes. */
export function harness(overrides: HarnessOptions = {}): Harness {
  const runScan = vi.fn(async (_input: unknown, scanDeps: ScanDependencies) => {
    // The scan runner always asks for the transport, so the live check before every
    // outbound request runs.
    await scanDeps.fetch('https://example.com/', { method: 'GET', signal: scanDeps.signal });
    return observation;
  });
  const claimScan = vi.fn(async () =>
    'claimResult' in overrides
      ? (overrides.claimResult ?? null)
      : overrides.scan === undefined
        ? scan
        : overrides.scan,
  );
  const stopQueuedScan = vi.fn(async () => 'stopped' as const);
  const recordScanOutcomeAttempt = vi.fn(async () => 'recorded' as const);
  const readLiveScanState = vi.fn(
    async () =>
      overrides.liveState ?? {
        paused: overrides.paused ?? false,
        administrator:
          overrides.administrator === undefined
            ? { id: 'admin-1', email: 'admin@example.com', emailVerified: true }
            : overrides.administrator,
        removed: false,
        authorized: true,
      },
  );

  const liveSite = {
    ...site,
    authorization: {
      ...site.authorization,
      scopeVersion: overrides.siteScopeVersion ?? 1,
    },
  } as unknown as WebScanSite;

  const store = {
    getScan: vi.fn(async () => (overrides.scan === undefined ? scan : overrides.scan)),
    getSite: vi.fn(async () => liveSite),
    getSettings: vi.fn(async () => ({
      paused: overrides.paused ?? false,
      contact: 'current-defaults@example.com',
      limits: {
        maxRequests: 999,
        maxPages: 999,
        maxActiveLinks: 999,
        requestsPerSecond: 1,
        requestTimeoutMs: 1000,
        maxResponseBytes: 1024,
        totalTimeoutMs: 60_000,
      },
      checks: {},
      retentionDays: 365,
      defaultSchedule: { frequency: 'weekly', weekday: 5, hour: 4, minute: 0, enabled: false },
      alertsEnabled: false,
      approvedInstallations: [],
    })),
    listRetainedOccurrences: vi.fn(async () => []),
    listAudit: vi.fn(async () => overrides.audit ?? []),
  } as unknown as WebScanStore;

  const workerStore = {
    claimScan,
    stopQueuedScan,
    recordScanOutcomeAttempt,
    readLiveScanState,
    heartbeatScan: vi.fn(async () => true),
    loadAdministratorIdentity: vi.fn(
      async () =>
        overrides.administrator === undefined
          ? { id: 'admin-1', email: 'admin@example.com', emailVerified: true }
          : overrides.administrator,
    ),
  } as unknown as WebScanWorkerStore;

  const deps = {
    store: {
      ...store,
      openSiteIdentityKey: vi.fn(async () =>
        overrides.identityKey === undefined
          ? Buffer.alloc(32).toString('base64')
          : overrides.identityKey,
      ),
    },
    workerStore,
    pool: fakePool(),
    platformAdmins: overrides.platformAdmins ?? ['admin@example.com'],
    runScan,
    compare: vi.fn(() => ({ updates: [], retained: [] })),
    createFetch: vi.fn(() => vi.fn(async () => new Response('ok'))),
    now: () => new Date('2026-01-02T02:00:00.000Z'),
    heartbeatMs: 60_000,
  } as unknown as WebScanWorkerDeps;

  return {
    deps,
    runScan,
    claimScan,
    stopQueuedScan,
    recordScanOutcomeAttempt,
    readLiveScanState,
  };
}

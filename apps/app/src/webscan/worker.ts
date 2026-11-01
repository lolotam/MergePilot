import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ScanStopError,
  compareScan,
  createSiteIdentity,
  type ComparisonResult,
  type RetainedOccurrence,
  type ScanDependencies,
  type ScanInput,
  type ScanObservation,
  type SiteIdentity,
} from '@mergepilot/webscan';
import { createScanAbortController, type WebScanAbortController } from './abort.js';
import type { WebScanEventPublisher } from './events.js';
import type { GuardedScanFetch } from './guarded-fetch.js';
import { acquireScanLease, type ScanLease } from './lease.js';
import type { WebScanStore } from './store.js';
import type { WebScanScan, WebScanSite } from './types.js';
import { liveRefusal, packageRefusalReason, refusalReason, type WebScanRefusal } from './worker-authorization.js';
import { defaultFetchFactory, defaultRunScan, sleepWithSignal } from './worker-defaults.js';
import { toOccurrenceUpdates, toScanFindings } from './worker-outcome.js';
import {
  failedReason,
  stoppedReason,
  type WebScanWorkerReason,
} from './worker-reasons.js';
import {
  readRunSettings,
  WebScanSettingsError,
  type WebScanRunSettings,
} from './worker-settings.js';
import type { WebScanLiveAttempt, WebScanWorkerStore } from './worker-store.js';

/**
 * The scan worker (ADR-0052 sections 5 and 7).
 *
 * The worker is the only place that runs a scan. It holds the global advisory lease for
 * the whole run, it claims the queued scan atomically, it re-checks the live
 * authorization before the claim and before every outbound request, and it writes the
 * terminal state fenced by its own attempt id.
 *
 * Every guard fails closed: a state that cannot be read stops the scan instead of
 * letting it continue on a guess.
 */

/** The logger of the worker. */
export interface WebScanWorkerLogger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

/**
 * The store the worker needs.
 *
 * It is the shared store plus the one capability that opens the identity key of a
 * site. The key is opened through the store, so the binding between the key and the
 * site stays in one place and the worker never handles a sealed envelope.
 */
export interface WebScanWorkerStoreFacade extends WebScanStore {
  /**
   * Opens the identity key of a site.
   *
   * The key is only used to derive the per-site fingerprint function of the package.
   * It never leaves this call and it is never written anywhere.
   */
  openSiteIdentityKey(siteId: string): Promise<string | null>;
}

/** The guarded transport the worker builds for one scan. */
export type WebScanFetchFactory = (options: {
  hostname: string;
  contact: string;
  maxResponseBytes: number;
}) => GuardedScanFetch;

/** The dependencies of the worker. */
export interface WebScanWorkerDeps {
  /** The shared store. */
  store: WebScanWorkerStoreFacade;
  /** The worker persistence. */
  workerStore: WebScanWorkerStore;
  /** The pool the advisory lease is taken from. */
  pool: Pool;
  /** The deployed platform administrator list. */
  platformAdmins: readonly string[];
  /** The clock. */
  now?: (() => Date) | undefined;
  /** The logger. */
  logger?: WebScanWorkerLogger | undefined;
  /** The progress publisher. */
  events?: WebScanEventPublisher | undefined;
  /** The scan runner of the package. */
  runScan?: ((input: ScanInput, deps: ScanDependencies) => Promise<ScanObservation>) | undefined;
  /** The comparison of the package. */
  compare?:
    | ((current: ScanObservation, retained: readonly RetainedOccurrence[]) => ComparisonResult)
    | undefined;
  /** The factory of the guarded transport. */
  createFetch?: WebScanFetchFactory | undefined;
  /** How often the heartbeat is written, in milliseconds. */
  heartbeatMs?: number | undefined;
}

/** How a scan job ended. */
export type WebScanRunOutcome =
  | 'missing'
  | 'terminal'
  | 'not_claimed'
  | 'stopped'
  | 'completed'
  | 'failed';

/** The default heartbeat interval. */
export const WEB_SCAN_HEARTBEAT_MS = 30_000;

/** The options of one run of the worker. */
export interface ProcessScanJobOptions {
  /**
   * The controller that owns the abort of the run.
   *
   * The runtime hands its controller in, so a cancel, a shutdown or a lost job lock
   * stops the run that is in flight. Without one the run owns its own controller.
   */
  abort?: WebScanAbortController | undefined;
}

/**
 * Runs one queued scan.
 *
 * The scan is never run twice: the claim is atomic, and a scan that already has a
 * terminal state is left alone.
 */
export async function processScanJob(
  scanId: string,
  deps: WebScanWorkerDeps,
  options?: ProcessScanJobOptions,
): Promise<WebScanRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger;
  const abort = options?.abort ?? createScanAbortController();

  const scan = await deps.store.getScan(scanId);
  if (scan === null) return 'missing';
  if (isTerminal(scan)) return 'terminal';

  const site = await deps.store.getSite(scan.siteId);
  if (site === null) {
    await stopQueued(deps, scan, 'site_missing', now());
    return 'stopped';
  }

  // The kill switch and the authorization are checked before the claim, so a paused
  // scanner never even takes the scan.
  const refusal = await refusalReason(deps, site, scan);
  if (refusal !== null) {
    await stopQueued(deps, scan, refusal, now());
    return 'stopped';
  }

  // A run that was aborted before it started never claims the scan and never sends a
  // request: the owner of the run said that no scan may run any more.
  if (abort.signal.aborted) {
    await stopQueued(deps, scan, abort.reason ?? 'cancelled', now());
    return 'stopped';
  }

  // The lease is taken before the scan and is held until it ends. A scan that cannot
  // take the lease does not start; the job fails and is retried.
  const lease = await acquireScanLease({
    pool: deps.pool,
    onConnectionLost: (errorName) => {
      logger?.warn?.('The web scan lease connection was lost', { scanId, error: errorName });
      // The lease is gone, so the scan may not send another request. The run stops
      // instead of continuing against a lock that no longer belongs to it.
      abort.abort('lease_lost');
    },
  });

  const attemptId = randomUUID();
  try {
    const claimed = await deps.workerStore.claimScan({ scanId, attemptId, now: now() });
    if (claimed === null) {
      // Another worker claimed it, or it already reached a terminal state.
      return 'not_claimed';
    }

    const heartbeat = startHeartbeat(deps, claimed.id, attemptId, now);
    try {
      return await runClaimedScan(deps, claimed, site, lease, attemptId, now, abort);
    } finally {
      await heartbeat.stop();
    }
  } finally {
    await lease.release();
  }
}

/** Whether a scan already reached a terminal state. */
function isTerminal(scan: WebScanScan): boolean {
  return scan.status === 'completed' || scan.status === 'stopped' || scan.status === 'failed';
}

/** Stops a queued scan without sending a single request. */
async function stopQueued(
  deps: WebScanWorkerDeps,
  scan: WebScanScan,
  reason: string,
  now: Date,
): Promise<void> {
  const result = await deps.workerStore.stopQueuedScan({ scanId: scan.id, reason, now });
  deps.logger?.info?.('The web scan was stopped before it started', {
    scanId: scan.id,
    reason,
    result,
  });
}

/**
 * The reason the scan must not start, or null when it may.
 *
 * A state that cannot be read is a refusal: the scan fails closed instead of running
 * against an unknown authorization.
 */

/** The heartbeat of a claimed run. */
interface Heartbeat {
  stop(): Promise<void>;
}

/** Writes the heartbeat of the attempt until the run ends. */
function startHeartbeat(
  deps: WebScanWorkerDeps,
  scanId: string,
  attemptId: string,
  now: () => Date,
): Heartbeat {
  const interval = deps.heartbeatMs ?? WEB_SCAN_HEARTBEAT_MS;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void deps.workerStore
      .heartbeatScan({ scanId, attemptId, now: now() })
      .catch((error: unknown) => {
        deps.logger?.warn?.('The web scan heartbeat failed', {
          scanId,
          error: error instanceof Error ? error.name : 'unknown error',
        });
      });
  }, interval);
  // The heartbeat must never hold the process open.
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Runs a claimed scan and writes its terminal state. */
async function runClaimedScan(
  deps: WebScanWorkerDeps,
  scan: WebScanScan,
  site: WebScanSite,
  lease: ScanLease,
  attemptId: string,
  now: () => Date,
  abort: WebScanAbortController,
): Promise<WebScanRunOutcome> {
  const runScan = deps.runScan ?? defaultRunScan;
  const compare = deps.compare ?? compareScan;
  const attempt: WebScanLiveAttempt = { scanId: scan.id, attemptId };

  // The last progress the scan reported. It is the only count available when the scan
  // ends without an observation, and it never carries anything but counters.
  const progress = { requests: 0, pages: 0, elapsedMs: 0 };
  // The refusal that stopped the last request, when one did. It is more precise than
  // the reason of the package, which only knows that the scan stopped.
  let refusal: WebScanRefusal | null = null;

  let observation: ScanObservation;
  try {
    // The identity key and the guarded transport are opened inside the guard, so a site
    // whose key cannot be opened still reaches a terminal state.
    const identity = await resolveIdentity(deps, site);
    const createFetch = deps.createFetch ?? defaultFetchFactory;

    // The scan runs the settings it was queued with and not the current global
    // defaults. A record that cannot be read is a refusal, never a fallback.
    let settings: WebScanRunSettings;
    try {
      settings = readRunSettings(scan.effectiveSettings);
    } catch (error) {
      if (error instanceof WebScanSettingsError) {
        await writeRefused(deps, scan, site, attemptId, now(), error.reason, progress);
        return 'stopped';
      }
      throw error;
    }

    const controller = new AbortController();
    const stopOnAbort = (): void => {
      controller.abort(abort.signal.reason);
    };
    if (abort.signal.aborted) {
      stopOnAbort();
    } else {
      abort.signal.addEventListener('abort', stopOnAbort, { once: true });
    }

    try {
      const guarded = createFetch({
        hostname: settings.scope.hostname,
        contact: settings.contact,
        maxResponseBytes: settings.limits.maxResponseBytes,
      });

      const input: ScanInput = {
        scope: settings.scope,
        limits: settings.limits,
        checks: settings.checks,
        contact: settings.contact,
      };

      const deps_: ScanDependencies = {
        fetch: async (url, init) => {
          // The live checks happen before every outbound request: a closed kill switch, a
          // removed site, a revoked administrator, a changed scope version, a lost
          // attempt or a lost lease stops the scan here.
          const live = await liveRefusal(deps, site, lease, scan, attempt);
          if (live !== null) {
            refusal = live.reason;
            throw new ScanStopError(
              packageRefusalReason(live.reason),
              'The scan is no longer authorized.',
            );
          }
          return guarded(url, init);
        },
        now: () => now().getTime(),
        sleep: (milliseconds, signal) => sleepWithSignal(milliseconds, signal),
        signal: controller.signal,
        onProgress: (update) => {
          progress.requests = update.requests;
          progress.pages = update.pages;
          progress.elapsedMs = update.elapsedMs;
          deps.events?.publish({
            scanId: scan.id,
            siteId: site.id,
            kind: 'progress',
            status: 'running',
            requests: update.requests,
            pages: update.pages,
            elapsedMs: update.elapsedMs,
          });
        },
        identifyTarget: identity.identifyTarget,
        identifyOccurrence: (occurrence) => identity.identifyOccurrence(occurrence),
      };

      observation = await runScan(input, deps_);
    } finally {
      abort.signal.removeEventListener('abort', stopOnAbort);
    }
  } catch (error) {
    // A scan that stops or fails still reaches a terminal state, otherwise it would
    // stay running until the reconciliation finds it.
    const stopped = error instanceof ScanStopError;
    const reason: WebScanWorkerReason = stopped
      ? stoppedReason(abort, refusal, error)
      : failedReason(error);
    const write = await deps.workerStore.recordScanOutcomeAttempt(`worker:${attemptId}`, {
      scanId: scan.id,
      siteId: site.id,
      attemptId,
      now: now(),
      status: stopped ? 'stopped' : 'failed',
      ...(stopped ? { stopReason: reason } : { failReason: reason }),
      requests: progress.requests,
      pages: progress.pages,
      durationMs: progress.elapsedMs,
      findings: [],
      coverage: [],
      updates: [],
    });
    deps.events?.publish({
      scanId: scan.id,
      siteId: site.id,
      kind: stopped ? 'stopped' : 'failed',
      status: stopped ? 'stopped' : 'failed',
      requests: progress.requests,
      pages: progress.pages,
      elapsedMs: progress.elapsedMs,
    });
    deps.logger?.info?.('The web scan ended early', {
      scanId: scan.id,
      siteId: site.id,
      status: stopped ? 'stopped' : 'failed',
      reason,
      write,
    });
    return stopped ? 'stopped' : 'failed';
  }

  const retained = await deps.store.listRetainedOccurrences(site.id);
  const comparison = compare(observation, retained);

  // The reason of the worker wins over the reason of the package: the worker knows why
  // it aborted, and the package only knows that the scan stopped.
  const stopReason: WebScanWorkerReason | undefined =
    observation.status === 'stopped'
      ? (abort.reason ?? refusal ?? (observation.reason as WebScanWorkerReason))
      : undefined;
  const failReason: WebScanWorkerReason | undefined =
    observation.status === 'failed' ? (observation.reason as WebScanWorkerReason) : undefined;

  const write = await deps.workerStore.recordScanOutcomeAttempt(`worker:${attemptId}`, {
    scanId: scan.id,
    siteId: site.id,
    attemptId,
    now: now(),
    status: observation.status,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(failReason !== undefined ? { failReason } : {}),
    requests: observation.requests,
    pages: observation.pages,
    durationMs: observation.durationMs,
    findings: toScanFindings(observation, comparison, site.id, scan.id),
    coverage: [...observation.coverage],
    updates: toOccurrenceUpdates(comparison.updates),
  });

  deps.events?.publish({
    scanId: scan.id,
    siteId: site.id,
    kind: observation.status,
    status: observation.status,
    requests: observation.requests,
    pages: observation.pages,
    elapsedMs: observation.durationMs,
  });

  deps.logger?.info?.('The web scan ended', {
    scanId: scan.id,
    siteId: site.id,
    status: observation.status,
    write,
  });

  return observation.status === 'completed'
    ? 'completed'
    : observation.status === 'stopped'
      ? 'stopped'
      : 'failed';
}

/** Stops a claimed scan that may not run, without sending a single request. */
async function writeRefused(
  deps: WebScanWorkerDeps,
  scan: WebScanScan,
  site: WebScanSite,
  attemptId: string,
  now: Date,
  reason: WebScanWorkerReason,
  progress: { requests: number; pages: number; elapsedMs: number },
): Promise<void> {
  const write = await deps.workerStore.recordScanOutcomeAttempt(`worker:${attemptId}`, {
    scanId: scan.id,
    siteId: site.id,
    attemptId,
    now,
    status: 'stopped',
    stopReason: reason,
    requests: progress.requests,
    pages: progress.pages,
    durationMs: progress.elapsedMs,
    findings: [],
    coverage: [],
    updates: [],
  });
  deps.events?.publish({
    scanId: scan.id,
    siteId: site.id,
    kind: 'stopped',
    status: 'stopped',
    requests: progress.requests,
    pages: progress.pages,
    elapsedMs: progress.elapsedMs,
  });
  deps.logger?.info?.('The web scan was refused before it ran', {
    scanId: scan.id,
    siteId: site.id,
    reason,
    write,
  });
}

/**
 * The live refusal of the next request, or null when the scan may continue.
 *
 * A state that cannot be read is a refusal: the scan stops instead of sending another
 * request against an unknown state.
 */

/** Opens the identity key of a site and binds the identity functions to it. */
async function resolveIdentity(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
): Promise<SiteIdentity> {
  const plaintext = await deps.store.openSiteIdentityKey(site.id);
  if (plaintext === null) {
    throw new Error('The web scan site has no identity key');
  }
  const key = new Uint8Array(Buffer.from(plaintext, 'base64'));
  return createSiteIdentity(key);
}

/** The findings of the scan snapshot. */

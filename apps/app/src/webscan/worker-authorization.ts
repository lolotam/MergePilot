import { isUserPlatformAdmin } from '../admin/guard.js';
import type { ScanStopReason } from '@mergepilot/webscan';
import type { ScanLease } from './lease.js';
import type { WebScanAuditEntry, WebScanScan, WebScanSite } from './types.js';
import type {
  WebScanAdministratorIdentity,
  WebScanLiveAttempt,
  WebScanWorkerStore,
} from './worker-store.js';
import type { WebScanWorkerDeps } from './worker.js';

/**
 * The live authorization of a scan (ADR-0052 sections 1 and 5).
 *
 * The authorizing user must still exist, have a verified email and pass
 * `isUserPlatformAdmin` against the worker's current deployed platform administrator
 * list before a queued scan is claimed, before every outbound request and before each
 * alert write.
 *
 * The scan runs what was authorized. The scope, the limits, the checks and the contact
 * of the run are the ones the scan was queued with, and the scope version of the site
 * must still be the version the scan was queued under: a narrowed scope or a changed
 * schedule ends the run of the old authorization instead of letting it continue.
 *
 * The authorization a queued scan runs under is the one it was queued with. A site that
 * was authorized again keeps its queued work, and that work stays bound to the
 * administrator that authorized it, so a revoked original authorizer stops the scan even
 * when a new administrator took over the site.
 *
 * Every guard fails closed: a state that cannot be read stops the scan instead of
 * letting it continue on a guess.
 */

/** Why a scan may not start, or continue. */
export type WebScanRefusal =
  | 'kill_switch'
  | 'authorization_revoked'
  | 'lease_lost'
  | 'scope_changed'
  | 'attempt_lost';

/**
 * The reason of the package a refusal maps to.
 *
 * The package of the scanner knows a fixed set of stop reasons. A changed scope version
 * and a lost attempt are the loss of the authorization and of the ownership of the run,
 * which the package reports as `authorization_revoked` and as `lease_lost`. The precise
 * reason of the worker is kept next to it, in the `stop_reason` column of the scan.
 */
export function packageRefusalReason(reason: WebScanRefusal): ScanStopReason {
  switch (reason) {
    case 'kill_switch':
    case 'authorization_revoked':
    case 'lease_lost':
      return reason;
    case 'scope_changed':
      return 'authorization_revoked';
    case 'attempt_lost':
      return 'lease_lost';
  }
}

/**
 * The reason the scan must not start, or null when it may.
 *
 * A state that cannot be read is a refusal: the scan fails closed instead of running
 * against an unknown authorization.
 */
export async function refusalReason(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
  scan: WebScanScan,
): Promise<string | null> {
  const settings = await deps.store.getSettings();
  if (settings.paused) return 'kill_switch';
  if (site.removedAt !== null) return 'site_removed';
  if (site.authorization.authorizedBy === null) return 'authorization_revoked';
  if (site.authorization.auditId === null) return 'authorization_revoked';
  // The site must still carry the scope version the scan was queued under.
  if (site.authorization.scopeVersion !== scan.scopeVersion) return 'scope_changed';

  const administrator = await loadAuthorizingAdministrator(deps, site, scan);
  if (administrator === null) return 'authorization_revoked';
  if (!isUserPlatformAdmin(administrator, deps.platformAdmins)) return 'authorization_revoked';
  return null;
}

/**
 * The live refusal of the next request, or null when the scan may continue.
 *
 * A state that cannot be read is a refusal: the scan stops instead of sending another
 * request against an unknown state.
 */
export async function liveRefusal(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
  lease: ScanLease,
  scan: WebScanScan,
  attempt: WebScanLiveAttempt,
): Promise<{ reason: WebScanRefusal } | null> {
  if (!lease.isAlive()) return { reason: 'lease_lost' };

  let state: Awaited<ReturnType<WebScanWorkerStore['readLiveScanState']>>;
  try {
    state = await deps.workerStore.readLiveScanState(site.id, attempt);
  } catch (error) {
    deps.logger?.warn?.('The live web scan state could not be read', {
      siteId: site.id,
      scanId: scan.id,
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return { reason: 'kill_switch' };
  }
  if (state === null) return { reason: 'authorization_revoked' };
  if (state.paused) return { reason: 'kill_switch' };
  if (state.removed) return { reason: 'authorization_revoked' };
  if (!state.authorized) return { reason: 'authorization_revoked' };
  // A scan that lost its row to a cancel must not finish a scan nobody owns any more.
  if (state.attemptOwned === false) return { reason: 'attempt_lost' };

  // The site must still carry the scope version the scan was queued under. A scope or a
  // schedule change ends the run of the old authorization.
  const scopeVersion = await liveScopeVersion(deps, state, site);
  if (scopeVersion === null) return { reason: 'kill_switch' };
  if (scopeVersion !== scan.scopeVersion) return { reason: 'scope_changed' };

  const administrator = await liveAuthorizingAdministrator(deps, state, site, scan);
  if (administrator === null) return { reason: 'authorization_revoked' };
  if (!isUserPlatformAdmin(administrator, deps.platformAdmins)) {
    return { reason: 'authorization_revoked' };
  }
  return null;
}

/**
 * The current scope version of the site.
 *
 * The shared live read carries it once it is extended; until then the version is read
 * from the site row. A site that cannot be read has no version, and the scan stops.
 */
async function liveScopeVersion(
  deps: WebScanWorkerDeps,
  state: Awaited<ReturnType<WebScanWorkerStore['readLiveScanState']>>,
  site: WebScanSite,
): Promise<number | null> {
  if (state !== null && state.scopeVersion !== undefined) return state.scopeVersion;
  try {
    const live = await deps.store.getSite(site.id);
    return live === null ? null : live.authorization.scopeVersion;
  } catch (error) {
    deps.logger?.warn?.('The live web scan scope version could not be read', {
      siteId: site.id,
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return null;
  }
}

/**
 * The identity of the administrator who gave the authorization the scan runs under.
 *
 * The shared live read carries it once it is extended; until then the identity is
 * resolved from the authorization of the site and from the audit log.
 */
async function liveAuthorizingAdministrator(
  deps: WebScanWorkerDeps,
  state: Awaited<ReturnType<WebScanWorkerStore['readLiveScanState']>>,
  site: WebScanSite,
  scan: WebScanScan,
): Promise<WebScanAdministratorIdentity | null> {
  if (state !== null && state.authorizingAdministrator !== undefined) {
    return state.authorizingAdministrator;
  }
  const actor = await resolveAuthorizingActor(deps, site, scan);
  if (actor === null) return null;
  try {
    return await deps.workerStore.loadAdministratorIdentity(actor);
  } catch (error) {
    deps.logger?.warn?.('The live web scan administrator could not be read', {
      siteId: site.id,
      scanId: scan.id,
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return null;
  }
}

/**
 * The user who gave the authorization the scan was queued with.
 *
 * The site may have been authorized again after the scan was queued. The queued scan
 * keeps the authorization it was queued with, so the original authorizer is the one
 * whose live verified administrator status decides whether the scan may run.
 *
 * The audit log is append-only, so the original authorizer is still readable there.
 */
export async function resolveAuthorizingActor(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
  scan: WebScanScan,
): Promise<string | null> {
  const reference = scan.authorizationAuditId;
  if (reference === null) return null;

  // The site still carries the authorization the scan was queued with.
  if (site.authorization.auditId === reference) {
    return site.authorization.authorizedBy;
  }

  // The site was authorized again. The original authorizer is read from the audit log.
  const entries = await readSiteAudit(deps, site);
  for (const entry of entries) {
    if (entry.id !== reference || entry.action !== 'site.authorize') continue;
    const authorizer = authorizedByOf(entry);
    if (authorizer !== null) return authorizer;
  }
  return null;
}

/**
 * The audit rows of a site.
 *
 * The first authorization of a site is recorded against the hostname of the site and
 * every later one against its id, so both are read.
 */
async function readSiteAudit(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
): Promise<readonly WebScanAuditEntry[]> {
  const entries: WebScanAuditEntry[] = [];
  try {
    entries.push(
      ...(await deps.store.listAudit({ targetType: 'site', targetId: site.id, limit: 200 })),
    );
    entries.push(
      ...(await deps.store.listAudit({ targetType: 'site', targetId: site.hostname, limit: 50 })),
    );
  } catch (error) {
    deps.logger?.warn?.('The web scan audit log could not be read', {
      siteId: site.id,
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return [];
  }
  return entries;
}

/** The administrator of an authorization row, or null when the row does not name one. */
function authorizedByOf(entry: WebScanAuditEntry): string | null {
  const after = entry.after;
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return null;
  const authorizer = (after as Record<string, unknown>).authorizedBy;
  return typeof authorizer === 'string' && authorizer.length > 0 ? authorizer : null;
}

/**
 * The identity of the administrator who authorized the site, with the current
 * verification state.
 *
 * It is read before the claim, so a revoked administrator, an unverified email or a
 * removed administrator stops the scan before it starts.
 */
async function loadAuthorizingAdministrator(
  deps: WebScanWorkerDeps,
  site: WebScanSite,
  scan: WebScanScan,
): Promise<WebScanAdministratorIdentity | null> {
  const actor = await resolveAuthorizingActor(deps, site, scan);
  if (actor === null) return null;
  try {
    return await deps.workerStore.loadAdministratorIdentity(actor);
  } catch (error) {
    deps.logger?.warn?.('The web scan administrator could not be read', {
      siteId: site.id,
      scanId: scan.id,
      error: error instanceof Error ? error.name : 'unknown error',
    });
    return null;
  }
}

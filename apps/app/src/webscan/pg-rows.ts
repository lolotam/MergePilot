import type { ScanScope } from '@mergepilot/webscan';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppTx } from '../db/workspace-lock.js';
import {
  webScanAlerts,
  webScanExceptions,
  webScanFindings,
  webScanOccurrences,
  webScanSites,
  webScans,
} from '../db/schema.js';
import type {
  WebScanAlert,
  WebScanException,
  WebScanFinding,
  WebScanOccurrence,
  WebScanScan,
  WebScanSite,
} from './types.js';

/**
 * The row shapes of the scanner tables and the mappers onto the domain types.
 *
 * Keeping the mappers in one place means every reader sees the same view of a row,
 * and the domain types never leak a database column.
 */

export type SiteRow = typeof webScanSites.$inferSelect;
export type ScanRow = typeof webScans.$inferSelect;
export type FindingRow = typeof webScanFindings.$inferSelect;
export type OccurrenceRow = typeof webScanOccurrences.$inferSelect;
export type ExceptionRow = typeof webScanExceptions.$inferSelect;
export type AlertRow = typeof webScanAlerts.$inferSelect;

/**
 * The safe default scope of a site.
 *
 * Every list is empty: an empty allow list authorizes no crawl link and no active
 * probe. A site that was removed and registered again starts from this scope.
 */
export function defaultScope(hostname: string, baseUrl: string): ScanScope {
  return {
    hostname,
    baseUrl,
    crawlPaths: [],
    blockedPaths: [],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
  };
}

/**
 * Normalizes a hostname.
 *
 * The hostname is matched exactly, never by suffix, so it is lower-cased and a
 * trailing dot is removed. A value that carries a scheme, a path or a query is
 * rejected instead of being silently trimmed.
 */
export function normalizeHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 253) {
    throw new Error('The hostname is not a valid host name');
  }
  if (value.includes('/') || value.includes('?') || value.includes('#') || value.includes('@')) {
    throw new Error('The hostname must not carry a scheme, a path or a query');
  }
  const withoutDot = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(withoutDot)) {
    throw new Error('The hostname is not a valid host name');
  }
  return withoutDot;
}

/**
 * Normalizes the base URL of a site.
 *
 * The base URL is query-free and fragment-free: it is the origin the scanner starts
 * from, never a deep link.
 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The base URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The base URL must use http or https');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('The base URL must not carry a query or a fragment');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** The identity key of a new site: 32 random bytes, sealed before they are stored. */
export function newIdentityKey(): string {
  return randomBytes(32).toString('base64');
}

/** Locks the site row of one id. */
export async function lockSiteRow(tx: AppTx, siteId: string): Promise<SiteRow | null> {
  const rows = await tx.select().from(webScanSites).where(eq(webScanSites.id, siteId)).for('update');
  return rows[0] ?? null;
}

/**
 * Reads a scan row inside a transaction, without locking it.
 *
 * The lock order of the scanner is settings, site, scan, occurrence. The site of a
 * scan is therefore read first, so the site row that is locked is the site of the
 * scan and not the site a caller claims. The row is locked again afterwards.
 */
export async function readScanRow(tx: AppTx, scanId: string): Promise<ScanRow | null> {
  const rows = await tx.select().from(webScans).where(eq(webScans.id, scanId)).limit(1);
  return rows[0] ?? null;
}

/** Locks the scan row of one id. */
export async function lockScanRow(tx: AppTx, scanId: string): Promise<ScanRow | null> {
  const rows = await tx.select().from(webScans).where(eq(webScans.id, scanId)).for('update');
  return rows[0] ?? null;
}

/** Maps a site row onto the domain type. */
export function toWebScanSite(row: SiteRow): WebScanSite {
  const scope = (row.overrides ?? defaultScope(row.hostname, row.baseUrl)) as ScanScope;
  return {
    id: row.id,
    hostname: row.hostname,
    baseUrl: row.baseUrl,
    ownerUserId: row.ownerUserId,
    repository:
      row.repositoryId !== null &&
      row.installationId !== null &&
      row.githubAccountId !== null &&
      row.repositoryOwner !== null &&
      row.repositoryName !== null
        ? {
            owner: row.repositoryOwner,
            name: row.repositoryName,
            repositoryId: row.repositoryId,
            installationId: row.installationId,
            githubAccountId: row.githubAccountId,
          }
        : null,
    scope,
    schedule: row.schedule,
    authorization: {
      auditId: row.authorizationAuditId,
      authorizedBy: row.authorizedBy,
      authorizedAt: row.authorizedAt,
      scopeVersion: row.scopeVersion,
    },
    alertEpisodes: row.alertEpisodes ?? [],
    lastCoverage: row.lastCoverageSummary ?? null,
    lastCoverageScanId: row.lastCoverageScanId,
    lastCoverageAt: row.lastCoverageAt,
    nextRunAt: row.nextRunAt,
    lastScanAt: row.lastScanAt,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps a scan row onto the domain type. */
export function toWebScanScan(row: ScanRow): WebScanScan {
  return {
    id: row.id,
    siteId: row.siteId,
    trigger: row.trigger as WebScanScan['trigger'],
    status: row.status as WebScanScan['status'],
    scheduledFor: row.scheduledFor,
    idempotencyKey: row.idempotencyKey,
    outboxState: row.outboxState as WebScanScan['outboxState'],
    attemptId: row.attemptId,
    heartbeatAt: row.heartbeatAt,
    stopReason: row.stopReason,
    failReason: row.failReason,
    requests: row.requests,
    pages: row.pages,
    durationMs: row.durationMs,
    effectiveSettings: (row.effectiveSettings ?? {}) as Record<string, unknown>,
    coverageSummary: row.coverageSummary,
    authorizationAuditId: row.authorizationAuditId,
    scopeVersion: row.scopeVersion,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Maps a finding row onto the domain type. */
export function toWebScanFinding(row: FindingRow): WebScanFinding {
  return {
    id: row.id,
    scanId: row.scanId,
    siteId: row.siteId,
    issueKey: row.issueKey,
    occurrenceKey: row.occurrenceKey,
    targetKey: row.targetKey,
    checkId: row.checkId as WebScanFinding['checkId'],
    checkVersion: row.checkVersion,
    issueId: row.issueId,
    subject: row.subject,
    severity: row.severity as WebScanFinding['severity'],
    validation: row.validation as WebScanFinding['validation'],
    confidence: row.confidence as WebScanFinding['confidence'],
    safeLocation: row.safeLocation,
    evidence: row.evidence,
    evidenceHash: row.evidenceHash,
    comparison: row.comparison as WebScanFinding['comparison'],
  };
}

/** Maps an occurrence row onto the domain type. */
export function toWebScanOccurrence(row: OccurrenceRow): WebScanOccurrence {
  return {
    id: row.id,
    siteId: row.siteId,
    occurrenceKey: row.occurrenceKey,
    targetKey: row.targetKey,
    issueKey: row.issueKey,
    checkId: row.checkId as WebScanOccurrence['checkId'],
    checkVersion: row.checkVersion,
    issueId: row.issueId,
    subject: row.subject,
    severity: row.severity as WebScanOccurrence['severity'],
    validation: row.validation as WebScanOccurrence['validation'],
    confidence: row.confidence as WebScanOccurrence['confidence'],
    safeLocation: row.safeLocation,
    evidenceHash: row.evidenceHash,
    evidence: row.evidence,
    state: row.state as WebScanOccurrence['state'],
    archiveReason: row.archiveReason as WebScanOccurrence['archiveReason'],
    comparison: row.comparison as WebScanOccurrence['comparison'],
    lastObservedAt: row.lastObservedAt,
    lastCompletedScanId: row.lastCompletedScanId,
    exceptionId: row.exceptionId,
    notificationEpisodeRef: row.notificationEpisodeRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps an exception row onto the domain type. */
export function toWebScanException(row: ExceptionRow): WebScanException {
  return {
    id: row.id,
    siteId: row.siteId,
    occurrenceKey: row.occurrenceKey,
    evidenceHash: row.evidenceHash,
    kind: row.kind as WebScanException['kind'],
    reasonCategory: row.reasonCategory as WebScanException['reasonCategory'],
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

/** Maps an alert row onto the domain type. */
export function toWebScanAlert(row: AlertRow): WebScanAlert {
  return {
    id: row.id,
    siteId: row.siteId,
    issueKey: row.issueKey,
    episodeKey: row.episodeKey,
    repositoryId: row.repositoryId,
    installationId: row.installationId,
    githubAccountId: row.githubAccountId,
    issueNumber: row.issueNumber,
    deliveryMarker: row.deliveryMarker,
    deliveryState: row.deliveryState as WebScanAlert['deliveryState'],
    issueState: row.issueState as WebScanAlert['issueState'],
    occurrenceKeys: row.occurrenceKeys ?? [],
    lastDeliveredAt: row.lastDeliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

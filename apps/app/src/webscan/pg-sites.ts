import { randomUUID } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import { webScanSites } from '../db/schema.js';
import { WEBSCAN_IDENTITY_PURPOSE, type ScopedSecretVault } from '../vault/scoped-secrets.js';
import { appendAudit } from './pg-audit.js';
import { canonicalize, stopQueuedScansForSite } from './pg-scans.js';
import {
  lockSiteRow,
  newIdentityKey,
  normalizeBaseUrl,
  normalizeHostname,
  toWebScanSite,
} from './pg-rows.js';
import { lockSettingsRow } from './pg-settings.js';
import { parseSchedule } from './schedule.js';
import {
  WebScanConflictError,
  WebScanNotFoundError,
  type CreateWebScanSiteInput,
  type UpdateWebScanSiteInput,
} from './store.js';
import type { WebScanSite } from './types.js';

/**
 * The sites of the scanner (ADR-0052 section 6).
 *
 * A site is platform-owned. Its identity key is sealed with the purpose-scoped vault,
 * so the key bytes never reach the database, the audit log, the API or an export.
 */

/** Reads the site of one id. */
export async function readSite(db: AppDb, siteId: string): Promise<WebScanSite | null> {
  const rows = await db.select().from(webScanSites).where(eq(webScanSites.id, siteId));
  const row = rows[0];
  return row === undefined ? null : toWebScanSite(row);
}

/** Reads the site of one hostname. */
export async function readSiteByHostname(
  db: AppDb,
  hostname: string,
): Promise<WebScanSite | null> {
  const rows = await db
    .select()
    .from(webScanSites)
    .where(sql`lower(${webScanSites.hostname}) = ${normalizeHostname(hostname)}`);
  const row = rows[0];
  return row === undefined ? null : toWebScanSite(row);
}

/** Lists the sites. A removed site is only listed when it is asked for. */
export async function listSites(
  db: AppDb,
  options?: { includeRemoved?: boolean },
): Promise<WebScanSite[]> {
  const rows = await db
    .select()
    .from(webScanSites)
    .where(options?.includeRemoved === true ? undefined : isNull(webScanSites.removedAt))
    .orderBy(webScanSites.hostname);
  return rows.map(toWebScanSite);
}

/**
 * Registers a site.
 *
 * A hostname of a removed site restores its original row and id, so the history, the
 * identity key and the exceptions of that site survive. Everything that was stale is
 * reset: the schedule, the repository binding, the alert episodes and the scope. The
 * authorization is fresh, and the queued work of the removed site never comes back.
 *
 * Another owner cannot take the hostname over: the request conflicts until an
 * explicit audited transfer moves the ownership.
 */
export async function createSite(
  db: AppDb,
  actor: string,
  input: CreateWebScanSiteInput,
  secretVault: ScopedSecretVault,
): Promise<WebScanSite> {
  const hostname = normalizeHostname(input.hostname);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const scope = { ...input.scope, hostname, baseUrl };

  return db.transaction(async (tx) => {
    // The settings row is the global lock of the scanner. Taking it first keeps the
    // lock order of every write the same: settings, then site.
    await lockSettingsRow(tx);

    const existing = await tx
      .select()
      .from(webScanSites)
      .where(sql`lower(${webScanSites.hostname}) = ${hostname}`)
      .for('update');
    const current = existing[0];

    if (current !== undefined && current.removedAt === null) {
      throw new WebScanConflictError(`The hostname ${hostname} is already registered`);
    }

    if (current !== undefined && current.ownerUserId !== input.ownerUserId) {
      throw new WebScanConflictError(
        `The hostname ${hostname} belongs to another administrator and cannot be restored`,
      );
    }

    const now = new Date();
    // The schedule is normalized before it is written: a saved rule is always evaluable,
    // and a biweekly rule keeps the anchor it was saved with.
    const schedule = input.schedule === undefined ? null : parseSchedule(input.schedule, { savedAt: now });
    const authorizationAuditId = await appendAudit(tx, {
      actor,
      action: 'site.authorize',
      targetType: 'site',
      targetId: current?.id ?? hostname,
      after: { hostname, baseUrl, authorizedBy: input.authorizedBy },
    });

    if (current === undefined) {
      const siteId = randomUUID();
      const identityKey = newIdentityKey();
      const ciphertext = await secretVault.seal(identityKey, {
        purpose: WEBSCAN_IDENTITY_PURPOSE,
        scopeId: siteId,
      });

      const inserted = await tx
        .insert(webScanSites)
        .values({
          id: siteId,
          hostname,
          baseUrl,
          ownerUserId: input.ownerUserId,
          repositoryOwner: input.repository?.owner ?? null,
          repositoryName: input.repository?.name ?? null,
          repositoryId: input.repository?.repositoryId ?? null,
          installationId: input.repository?.installationId ?? null,
          githubAccountId: input.repository?.githubAccountId ?? null,
          identityKeyCiphertext: ciphertext,
          identityKeyVersion: secretVault.keyVersion,
          overrides: scope,
          schedule,
          authorizationAuditId,
          authorizedBy: input.authorizedBy,
          authorizedAt: now,
          scopeVersion: 1,
          alertEpisodes: [],
          nextRunAt: null,
          lastScanAt: null,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) {
        throw new Error('The web scan site was not written');
      }

      await appendAudit(tx, {
        actor,
        action: 'site.create',
        targetType: 'site',
        targetId: row.id,
        after: toWebScanSite(row),
      });

      return toWebScanSite(row);
    }

    // The restore path. The identity key and the envelope version survive, so the
    // occurrence keys of the site stay the same. Everything stale is reset.
    await stopQueuedScansForSite(tx, current.id, 'site_removed');

    const updated = await tx
      .update(webScanSites)
      .set({
        hostname,
        baseUrl,
        ownerUserId: input.ownerUserId,
        repositoryOwner: input.repository?.owner ?? null,
        repositoryName: input.repository?.name ?? null,
        repositoryId: input.repository?.repositoryId ?? null,
        installationId: input.repository?.installationId ?? null,
        githubAccountId: input.repository?.githubAccountId ?? null,
        overrides: scope,
        schedule,
        authorizationAuditId,
        authorizedBy: input.authorizedBy,
        authorizedAt: now,
        scopeVersion: current.scopeVersion + 1,
        alertEpisodes: [],
        nextRunAt: null,
        removedAt: null,
        updatedAt: now,
      })
      .where(eq(webScanSites.id, current.id))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new Error('The restored web scan site was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'site.restore',
      targetType: 'site',
      targetId: row.id,
      before: toWebScanSite(current),
      after: toWebScanSite(row),
    });

    return toWebScanSite(row);
  });
}

/**
 * Changes a site.
 *
 * A change of the scope or of the schedule bumps the scope version and stops the
 * scans that are still queued: they were authorized under the old scope, so they may
 * not run any more. A fresh authorization without a change of the scope leaves the
 * queued work alone.
 */
export async function updateSite(
  db: AppDb,
  actor: string,
  siteId: string,
  input: UpdateWebScanSiteInput,
): Promise<WebScanSite> {
  return db.transaction(async (tx) => {
    const current = await lockSiteRow(tx, siteId);
    if (current === null) {
      throw new WebScanNotFoundError('The web scan site');
    }
    if (current.removedAt !== null) {
      throw new WebScanConflictError('A removed site cannot be changed');
    }

    const now = new Date();
    // The schedule is normalized before it is compared and before it is written, so a
    // rule that is saved again in the same shape is not a change, and a saved rule is
    // always evaluable.
    const schedule =
      input.schedule === undefined ? undefined : parseSchedule(input.schedule, { savedAt: now });
    const scopeChanged =
      input.scope !== undefined && !sameValue(input.scope, current.overrides);
    const scheduleChanged = schedule !== undefined && !sameValue(schedule, current.schedule);
    const needsFreshAuthorization = input.authorizedBy !== undefined;

    // The queued scans of the old scope are stopped before the new scope is written,
    // so no scan can start under an authorization that no longer exists.
    const stopped = scopeChanged || scheduleChanged
      ? await stopQueuedScansForSite(tx, siteId, 'authorization_revoked')
      : 0;

    const authorizationAuditId = needsFreshAuthorization
      ? await appendAudit(tx, {
          actor,
          action: 'site.authorize',
          targetType: 'site',
          targetId: siteId,
          before: { authorizedBy: current.authorizedBy },
          after: { authorizedBy: input.authorizedBy },
        })
      : current.authorizationAuditId;

    const updated = await tx
      .update(webScanSites)
      .set({
        overrides: input.scope ?? current.overrides,
        schedule: schedule === undefined ? current.schedule : schedule,
        repositoryOwner:
          input.repository === undefined ? current.repositoryOwner : (input.repository?.owner ?? null),
        repositoryName:
          input.repository === undefined ? current.repositoryName : (input.repository?.name ?? null),
        repositoryId:
          input.repository === undefined ? current.repositoryId : (input.repository?.repositoryId ?? null),
        installationId:
          input.repository === undefined
            ? current.installationId
            : (input.repository?.installationId ?? null),
        githubAccountId:
          input.repository === undefined
            ? current.githubAccountId
            : (input.repository?.githubAccountId ?? null),
        authorizationAuditId,
        authorizedBy: input.authorizedBy ?? current.authorizedBy,
        authorizedAt: needsFreshAuthorization ? now : current.authorizedAt,
        // Only a change of the scope or of the schedule bumps the scope version. A
        // fresh authorization on its own records a new audit row, but the authorization
        // it replaces covered the same scope, so the queued work stays valid.
        scopeVersion: scopeChanged || scheduleChanged ? current.scopeVersion + 1 : current.scopeVersion,
        updatedAt: now,
      })
      .where(eq(webScanSites.id, siteId))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan site was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'site.update',
      targetType: 'site',
      targetId: siteId,
      before: toWebScanSite(current),
      after: toWebScanSite(row),
    });

    if (stopped > 0) {
      await appendAudit(tx, {
        actor,
        action: 'scan.stop',
        targetType: 'site',
        targetId: siteId,
        after: { stoppedScans: stopped, reason: 'authorization_revoked' },
      });
    }

    return toWebScanSite(row);
  });
}

/** Whether two values are the same, compared by their canonical JSON text. */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left ?? null)) === JSON.stringify(canonicalize(right ?? null));
}

/**
 * Removes a site.
 *
 * The removal is soft: the row, its history, its identity key and its exceptions
 * survive. The queued scans stop and the authorization is invalidated, so nothing
 * can scan the site until it is registered again with a fresh authorization.
 */
export async function removeSite(
  db: AppDb,
  actor: string,
  siteId: string,
): Promise<WebScanSite> {
  return db.transaction(async (tx) => {
    const current = await lockSiteRow(tx, siteId);
    if (current === null) {
      throw new WebScanNotFoundError('The web scan site');
    }
    if (current.removedAt !== null) {
      return toWebScanSite(current);
    }

    const now = new Date();
    const stopped = await stopQueuedScansForSite(tx, siteId, 'site_removed');

    const updated = await tx
      .update(webScanSites)
      .set({
        removedAt: now,
        authorizationAuditId: null,
        authorizedBy: null,
        authorizedAt: null,
        scopeVersion: current.scopeVersion + 1,
        schedule: null,
        nextRunAt: null,
        updatedAt: now,
      })
      .where(eq(webScanSites.id, siteId))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new Error('The web scan site was not written');
    }

    await appendAudit(tx, {
      actor,
      action: 'site.remove',
      targetType: 'site',
      targetId: siteId,
      before: toWebScanSite(current),
      after: toWebScanSite(row),
    });

    if (stopped > 0) {
      await appendAudit(tx, {
        actor,
        action: 'scan.stop',
        targetType: 'site',
        targetId: siteId,
        after: { stoppedScans: stopped, reason: 'site_removed' },
      });
    }

    return toWebScanSite(row);
  });
}

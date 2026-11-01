import { eq, sql } from 'drizzle-orm';
import type { AppDb } from '../db/pg-store.js';
import { webScanAlerts, webScanSites } from '../db/schema.js';
import { appendAudit, WEB_SCAN_ALERT_ACTOR } from './pg-audit.js';
import { toWebScanAlert } from './pg-rows.js';
import type { UpsertWebScanAlertInput } from './store.js';
import type { WebScanAlert, WebScanAlertEpisode } from './types.js';

/**
 * The alerts of the scanner (ADR-0052 section 8).
 *
 * The bounded episode state lives on the site row, not on a scan snapshot, so it
 * survives the expiry of the snapshots it was derived from. Archiving or pruning an
 * occurrence never touches it, so a churn of targets cannot reopen an episode that is
 * still unresolved.
 */

/** The delivery records of a site. */
export async function listAlerts(db: AppDb, siteId: string): Promise<WebScanAlert[]> {
  const rows = await db.select().from(webScanAlerts).where(eq(webScanAlerts.siteId, siteId));
  return rows.map(toWebScanAlert);
}

/**
 * Reserves or refreshes a delivery record.
 *
 * The marker is the idempotency key of the delivery: a second write with the same
 * marker updates the same record instead of opening a second issue.
 *
 * The state and its audit row share one transaction: a delivery state never exists
 * without a record of how it got there.
 */
export async function upsertAlert(db: AppDb, input: UpsertWebScanAlertInput): Promise<WebScanAlert> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .insert(webScanAlerts)
      .values({
        siteId: input.siteId,
        issueKey: input.issueKey,
        episodeKey: input.episodeKey,
        repositoryId: input.repositoryId,
        installationId: input.installationId,
        githubAccountId: input.githubAccountId,
        issueNumber: input.issueNumber ?? null,
        deliveryMarker: input.deliveryMarker,
        deliveryState: input.deliveryState,
        issueState: input.issueState,
        occurrenceKeys: input.occurrenceKeys,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: webScanAlerts.deliveryMarker,
        set: {
          issueNumber: input.issueNumber ?? null,
          deliveryState: input.deliveryState,
          issueState: input.issueState,
          occurrenceKeys: input.occurrenceKeys,
          updatedAt: now,
        },
      })
      .returning();

    const row = rows[0];
    if (row === undefined) {
      throw new Error('The web scan alert was not written');
    }

    await appendAudit(tx, {
      actor: WEB_SCAN_ALERT_ACTOR,
      action: 'alert.upsert',
      targetType: 'alert',
      targetId: row.id,
      after: {
        siteId: row.siteId,
        deliveryState: row.deliveryState,
        issueState: row.issueState,
        issueNumber: row.issueNumber,
      },
    });

    return toWebScanAlert(row);
  });
}

/**
 * Replaces the bounded episode state of a site.
 *
 * The state is written under the row lock of the site, so two workers never write a
 * state that lost an update. The write and its audit row share one transaction.
 */
export async function setSiteAlertEpisodes(
  db: AppDb,
  actor: string,
  siteId: string,
  episodes: WebScanAlertEpisode[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(webScanSites)
      .where(eq(webScanSites.id, siteId))
      .for('update');
    const current = rows[0];
    if (current === undefined) {
      throw new Error('The web scan site was not found');
    }

    await tx
      .update(webScanSites)
      .set({ alertEpisodes: episodes, updatedAt: new Date() })
      .where(eq(webScanSites.id, siteId));

    await appendAudit(tx, {
      actor,
      action: 'alert.episodes',
      targetType: 'site',
      targetId: siteId,
      before: current.alertEpisodes ?? [],
      after: episodes,
    });
  });
}

/** The bounded episode state of a site. */
export async function readSiteAlertEpisodes(
  db: AppDb,
  siteId: string,
): Promise<WebScanAlertEpisode[]> {
  const rows = await db
    .select({ episodes: webScanSites.alertEpisodes })
    .from(webScanSites)
    .where(sql`${webScanSites.id} = ${siteId}`);
  return rows[0]?.episodes ?? [];
}

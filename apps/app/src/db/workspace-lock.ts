import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { organization } from '../auth/schema.js';
import { WorkspaceDeletedError } from '../core/types.js';
import type { AppDb } from './pg-store.js';
import {
  installations,
  providerCredentials,
  reviewRuns,
  workspaceSettings,
  workspaceUsageMonthly,
} from './schema.js';
import type * as schema from './schema.js';

export type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

/**
 * The driver-neutral base of AppDb and AppTx. Some builder overloads (e.g. `returning({...})`)
 * do not resolve on the node-postgres | PGlite union; widening to the shared base type does.
 */
export type PgBase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Runs a workspace-scoped write in a transaction that first takes a share lock on the workspace's
 * Better Auth organization row. `PgStore.deleteWorkspace` deletes that row first, so a write racing
 * a deletion either commits before the deletion removes its rows, or waits and then throws
 * WorkspaceDeletedError. No write can recreate data for a deleted workspace.
 */
export async function withLiveWorkspace<T>(
  db: AppDb,
  workspaceId: string,
  write: (tx: AppTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const org = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, workspaceId))
      .for('share');
    if (org.length === 0) throw new WorkspaceDeletedError(workspaceId);
    return write(tx);
  });
}

/**
 * Deletes a workspace inside the caller's transaction. The organization row goes first (members
 * and invitations cascade), so writes holding its share lock (withLiveWorkspace) finish before this
 * proceeds and later ones see it gone and throw WorkspaceDeletedError. Then the workspace-scoped
 * rows (no foreign key to the organization), including the monthly usage, are removed and its
 * installations unlinked.
 * Returns whether the organization row existed.
 */
export async function deleteWorkspaceInTx(tx: AppTx, workspaceId: string): Promise<boolean> {
  const existing = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, workspaceId));
  await tx.delete(organization).where(eq(organization.id, workspaceId));
  await tx.delete(providerCredentials).where(eq(providerCredentials.workspaceId, workspaceId));
  await tx.delete(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  await tx.delete(reviewRuns).where(eq(reviewRuns.workspaceId, workspaceId));
  // After the runs: a run finishing concurrently commits its usage row before this delete runs.
  await tx.delete(workspaceUsageMonthly).where(eq(workspaceUsageMonthly.workspaceId, workspaceId));
  await tx
    .update(installations)
    .set({ workspaceId: null, updatedAt: new Date() })
    .where(eq(installations.workspaceId, workspaceId));
  return existing.length > 0;
}

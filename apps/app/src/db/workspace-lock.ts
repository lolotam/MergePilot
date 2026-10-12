import { eq } from 'drizzle-orm';
import { organization } from '../auth/schema.js';
import { WorkspaceDeletedError } from '../core/types.js';
import type { AppDb } from './pg-store.js';

type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

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

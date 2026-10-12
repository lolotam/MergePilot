import { count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import type { AdminDb } from './queries.js';

type AdminTx = Parameters<Parameters<AdminDb['transaction']>[0]>[0];

export type ActionResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; code: string; message: string };

/**
 * Removes every workspace-scoped row (these tables have no foreign key to `organization`),
 * unlinks its installations, then deletes the organization (members and invitations cascade).
 */
async function purgeWorkspace(tx: AdminTx, workspaceId: string): Promise<void> {
  await tx
    .delete(dbSchema.providerCredentials)
    .where(eq(dbSchema.providerCredentials.workspaceId, workspaceId));
  await tx
    .delete(dbSchema.workspaceSettings)
    .where(eq(dbSchema.workspaceSettings.workspaceId, workspaceId));
  await tx.delete(dbSchema.reviewRuns).where(eq(dbSchema.reviewRuns.workspaceId, workspaceId));
  await tx
    .update(dbSchema.installations)
    .set({ workspaceId: null, updatedAt: new Date() })
    .where(eq(dbSchema.installations.workspaceId, workspaceId));
  await tx.delete(authSchema.member).where(eq(authSchema.member.organizationId, workspaceId));
  await tx
    .delete(authSchema.invitation)
    .where(eq(authSchema.invitation.organizationId, workspaceId));
  await tx.delete(authSchema.organization).where(eq(authSchema.organization.id, workspaceId));
}

/**
 * Deletes a user (sessions, accounts, memberships and sent invitations cascade). Any workspace
 * left with no members is purged in the same transaction.
 */
export async function deleteUser(
  db: AdminDb,
  adminUserId: string,
  targetUserId: string,
  logger: FastifyBaseLogger,
): Promise<ActionResult> {
  if (adminUserId === targetUserId) {
    return {
      ok: false,
      status: 400,
      code: 'cannot_delete_self',
      message: 'You cannot delete your own account',
    };
  }

  const purged = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, targetUserId));
    if (existing.length === 0) return null;

    const memberships = await tx
      .select({ wsId: authSchema.member.organizationId })
      .from(authSchema.member)
      .where(eq(authSchema.member.userId, targetUserId));

    await tx.delete(authSchema.user).where(eq(authSchema.user.id, targetUserId));

    const orphaned: string[] = [];
    for (const { wsId } of memberships) {
      const remaining = await tx
        .select({ n: count() })
        .from(authSchema.member)
        .where(eq(authSchema.member.organizationId, wsId));
      if (Number(remaining[0]?.n ?? 0) === 0) {
        await purgeWorkspace(tx, wsId);
        orphaned.push(wsId);
      }
    }
    return orphaned;
  });

  if (purged === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'User not found' };
  }

  logger.info(
    { adminUserId, action: 'admin.delete_user', targetId: targetUserId, purgedWorkspaceIds: purged },
    'platform admin action',
  );
  return { ok: true };
}

/** Deletes a workspace's data and the organization in one transaction. */
export async function deleteWorkspace(
  db: AdminDb,
  adminUserId: string,
  workspaceId: string,
  logger: FastifyBaseLogger,
): Promise<ActionResult> {
  const found = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: authSchema.organization.id })
      .from(authSchema.organization)
      .where(eq(authSchema.organization.id, workspaceId));
    if (existing.length === 0) return false;
    await purgeWorkspace(tx, workspaceId);
    return true;
  });

  if (!found) {
    return { ok: false, status: 404, code: 'not_found', message: 'Workspace not found' };
  }

  logger.info(
    { adminUserId, action: 'admin.delete_workspace', targetId: workspaceId },
    'platform admin action',
  );
  return { ok: true };
}

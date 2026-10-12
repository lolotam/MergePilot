import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import * as authSchema from '../auth/schema.js';
import { deleteWorkspaceInTx } from '../db/workspace-lock.js';
import type { AdminDb } from './queries.js';

type AdminTx = Parameters<Parameters<AdminDb['transaction']>[0]>[0];

export interface WorkspaceRef {
  id: string;
  name: string;
}

export const SOLE_OWNER_CODE = 'sole_owner_of_shared_workspace';

export type ActionResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; code: string; message: string }
  | { ok: false; status: 409; code: string; message: string; workspaces: WorkspaceRef[] };

/**
 * Workspaces the user solely owns that still have other members. Deleting the user would leave
 * them with nobody able to manage them, so the delete is refused until they are handled.
 */
async function findSoleOwnedSharedWorkspaces(
  tx: AdminTx,
  userId: string,
): Promise<WorkspaceRef[]> {
  const m = authSchema.member;
  const owned = await tx
    .select({ id: authSchema.organization.id, name: authSchema.organization.name })
    .from(m)
    .innerJoin(authSchema.organization, eq(m.organizationId, authSchema.organization.id))
    .where(and(eq(m.userId, userId), eq(m.role, 'owner')))
    .orderBy(asc(authSchema.organization.name));

  const stranded: WorkspaceRef[] = [];
  for (const ws of owned) {
    const others = await tx
      .select({ role: m.role })
      .from(m)
      .where(and(eq(m.organizationId, ws.id), ne(m.userId, userId)));
    if (others.length > 0 && !others.some((o) => o.role === 'owner')) stranded.push(ws);
  }
  return stranded;
}

/**
 * Deletes a user (sessions, accounts, memberships and sent invitations cascade). Any workspace
 * left with no members is purged in the same transaction (via deleteWorkspaceInTx). Refused with 409 when the user is the
 * sole owner of a workspace that still has other members.
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

  const outcome = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, targetUserId));
    if (existing.length === 0) return null;

    const stranded = await findSoleOwnedSharedWorkspaces(tx, targetUserId);
    if (stranded.length > 0) return { stranded };

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
        await deleteWorkspaceInTx(tx, wsId);
        orphaned.push(wsId);
      }
    }
    return { orphaned };
  });

  if (outcome === null) {
    return { ok: false, status: 404, code: 'not_found', message: 'User not found' };
  }
  if ('stranded' in outcome) {
    return {
      ok: false,
      status: 409,
      code: SOLE_OWNER_CODE,
      message:
        'This user is the only owner of workspaces that still have other members. Delete those workspaces or transfer their ownership first.',
      workspaces: outcome.stranded,
    };
  }

  logger.info(
    { adminUserId, action: 'admin.delete_user', targetId: targetUserId, purgedWorkspaceIds: outcome.orphaned },
    'platform admin action',
  );
  return { ok: true };
}

/**
 * Deletes a workspace exactly like PgStore.deleteWorkspace: organization row first, then its data,
 * in one transaction. In-flight worker writes (withLiveWorkspace) then fail with
 * WorkspaceDeletedError, and the worker re-checks the installation link before publishing.
 */
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
    await deleteWorkspaceInTx(tx, workspaceId);
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

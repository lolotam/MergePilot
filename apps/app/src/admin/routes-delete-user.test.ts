import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { createSeededAdminApp, type AdminTestDb } from './admin.fixtures.js';

// Seed: u-regular is the only member (owner) of ws-1 "Acme Corp" and ws-2 "Solo Project".
describe('DELETE /api/admin/users/:userId — shared workspaces', () => {
  let app: FastifyInstance;
  let handle: AdminTestDb;
  let db: AdminTestDb['db'];
  let adminCookie: string;

  beforeEach(async () => {
    ({ app, handle, adminCookie } = await createSeededAdminApp());
    db = handle.db;
  });

  afterEach(async () => {
    await app.close();
    await handle.close();
  });

  async function addMember(userId: string, workspaceId: string, role: string): Promise<void> {
    await db
      .insert(authSchema.user)
      .values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true })
      .onConflictDoNothing();
    await db
      .insert(authSchema.member)
      .values({ id: `m-${userId}-${workspaceId}`, organizationId: workspaceId, userId, role });
  }

  function deleteUser(userId: string) {
    return app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${userId}`,
      headers: { cookie: adminCookie },
    });
  }

  it('refuses with 409 when the user is the sole owner of a workspace with other members', async () => {
    await addMember('u-other', 'ws-1', 'admin');
    const infoSpy = vi.spyOn(app.log, 'info');

    const res = await deleteUser('u-regular');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: {
        code: 'sole_owner_of_shared_workspace',
        message: expect.any(String),
        workspaces: [{ id: 'ws-1', name: 'Acme Corp' }],
      },
    });

    // Nothing was deleted — not even the solo workspace ws-2.
    const users = await db.select().from(authSchema.user);
    expect(users.map((u) => u.id)).toContain('u-regular');
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs.map((o) => o.id).sort()).toEqual(['ws-1', 'ws-2']);
    const members = await db.select().from(authSchema.member);
    expect(members).toHaveLength(3);
    expect(await db.select().from(dbSchema.reviewRuns)).toHaveLength(3);
    expect(await db.select().from(dbSchema.providerCredentials)).toHaveLength(2);

    const audited = infoSpy.mock.calls.some(
      (c) => typeof c[0] === 'object' && c[0] !== null && 'action' in c[0],
    );
    expect(audited).toBe(false);
  });

  it('deletes the user when another owner remains, purging only memberless workspaces', async () => {
    await addMember('u-other', 'ws-1', 'owner');

    const res = await deleteUser('u-regular');

    expect(res.statusCode).toBe(204);
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs.map((o) => o.id)).toEqual(['ws-1']);
    const runs = await db.select().from(dbSchema.reviewRuns);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.workspaceId === 'ws-1')).toBe(true);
  });

  it('deletes a plain member of a shared workspace and keeps that workspace intact', async () => {
    await addMember('u-member', 'ws-1', 'member');

    const res = await deleteUser('u-member');

    expect(res.statusCode).toBe(204);
    const orgs = await db.select().from(authSchema.organization);
    expect(orgs.map((o) => o.id).sort()).toEqual(['ws-1', 'ws-2']);
    const members = await db.select().from(authSchema.member);
    expect(members.map((m) => m.userId)).toEqual(['u-regular', 'u-regular']);
  });
});

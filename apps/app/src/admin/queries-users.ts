import { asc, count, desc, eq, inArray, max } from 'drizzle-orm';
import * as authSchema from '../auth/schema.js';
import { clampPagination, type AdminDb, type Pagination } from './queries.js';

export interface AdminUserItem {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  signInProviders: string[];
  lastSessionAt: string | null;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export interface AdminUsersPage extends Pagination {
  users: AdminUserItem[];
  total: number;
}

/** Newest users first. Selects only safe columns — never tokens or passwords. */
export async function getUsers(db: AdminDb, options: Partial<Pagination>): Promise<AdminUsersPage> {
  const { limit, offset } = clampPagination(options);
  const u = authSchema.user;

  const [totalRows, userRows] = await Promise.all([
    db.select({ n: count() }).from(u),
    db
      .select({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: u.emailVerified,
        image: u.image,
        createdAt: u.createdAt,
      })
      .from(u)
      .orderBy(desc(u.createdAt), desc(u.id))
      .limit(limit)
      .offset(offset),
  ]);

  const ids = userRows.map((row) => row.id);
  const providers = new Map<string, Set<string>>();
  const lastSession = new Map<string, Date>();
  const memberships = new Map<string, AdminUserItem['workspaces']>();

  if (ids.length > 0) {
    const [accountRows, sessionRows, memberRows] = await Promise.all([
      db
        .select({ userId: authSchema.account.userId, providerId: authSchema.account.providerId })
        .from(authSchema.account)
        .where(inArray(authSchema.account.userId, ids)),
      db
        .select({ userId: authSchema.session.userId, last: max(authSchema.session.updatedAt) })
        .from(authSchema.session)
        .where(inArray(authSchema.session.userId, ids))
        .groupBy(authSchema.session.userId),
      db
        .select({
          userId: authSchema.member.userId,
          id: authSchema.organization.id,
          name: authSchema.organization.name,
          role: authSchema.member.role,
        })
        .from(authSchema.member)
        .innerJoin(
          authSchema.organization,
          eq(authSchema.member.organizationId, authSchema.organization.id),
        )
        .where(inArray(authSchema.member.userId, ids))
        .orderBy(asc(authSchema.organization.name)),
    ]);

    for (const row of accountRows) {
      const set = providers.get(row.userId) ?? new Set<string>();
      set.add(row.providerId);
      providers.set(row.userId, set);
    }
    for (const row of sessionRows) {
      if (row.last) lastSession.set(row.userId, row.last);
    }
    for (const row of memberRows) {
      const list = memberships.get(row.userId) ?? [];
      list.push({ id: row.id, name: row.name, role: row.role });
      memberships.set(row.userId, list);
    }
  }

  return {
    users: userRows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      image: row.image,
      createdAt: row.createdAt.toISOString(),
      signInProviders: [...(providers.get(row.id) ?? [])].sort(),
      lastSessionAt: lastSession.get(row.id)?.toISOString() ?? null,
      workspaces: memberships.get(row.id) ?? [],
    })),
    total: Number(totalRows[0]?.n ?? 0),
    limit,
    offset,
  };
}

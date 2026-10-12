import { and, asc, count, desc, eq, inArray, max, sum } from 'drizzle-orm';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import { clampPagination, toUsd, type AdminDb, type Pagination } from './queries.js';

export interface AdminWorkspaceInstallation {
  id: number;
  accountLogin: string;
  repositorySelection: string;
  suspended: boolean;
}

export interface AdminWorkspaceItem {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  ownerEmail: string | null;
  installations: AdminWorkspaceInstallation[];
  providers: string[];
  runsCount: number;
  costUsdTotal: number;
  lastRunAt: string | null;
}

export interface AdminWorkspacesPage extends Pagination {
  workspaces: AdminWorkspaceItem[];
  total: number;
}

/** Newest workspaces first. Provider names only — never keys or ciphertext. */
export async function getWorkspaces(
  db: AdminDb,
  options: Partial<Pagination>,
): Promise<AdminWorkspacesPage> {
  const { limit, offset } = clampPagination(options);
  const org = authSchema.organization;

  const [totalRows, orgRows] = await Promise.all([
    db.select({ n: count() }).from(org),
    db
      .select({ id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt })
      .from(org)
      .orderBy(desc(org.createdAt), desc(org.id))
      .limit(limit)
      .offset(offset),
  ]);

  const ids = orgRows.map((row) => row.id);
  const members = new Map<string, number>();
  const owners = new Map<string, string>();
  const installs = new Map<string, AdminWorkspaceInstallation[]>();
  const providers = new Map<string, Set<string>>();
  const runStats = new Map<string, { n: number; cost: number; last: Date | null }>();

  if (ids.length > 0) {
    const m = authSchema.member;
    const runs = dbSchema.reviewRuns;
    const inst = dbSchema.installations;
    const creds = dbSchema.providerCredentials;
    const usage = dbSchema.workspaceUsageMonthly;

    const [memberRows, ownerRows, instRows, credRows, runRows, usageRows] = await Promise.all([
      db
        .select({ wsId: m.organizationId, n: count() })
        .from(m)
        .where(inArray(m.organizationId, ids))
        .groupBy(m.organizationId),
      db
        .select({ wsId: m.organizationId, email: authSchema.user.email })
        .from(m)
        .innerJoin(authSchema.user, eq(m.userId, authSchema.user.id))
        .where(and(inArray(m.organizationId, ids), eq(m.role, 'owner')))
        .orderBy(asc(m.createdAt)),
      db
        .select({
          wsId: inst.workspaceId,
          id: inst.id,
          accountLogin: inst.accountLogin,
          repositorySelection: inst.repositorySelection,
          suspended: inst.suspended,
        })
        .from(inst)
        .where(inArray(inst.workspaceId, ids))
        .orderBy(asc(inst.accountLogin)),
      db
        .select({ wsId: creds.workspaceId, provider: creds.provider })
        .from(creds)
        .where(inArray(creds.workspaceId, ids)),
      db
        .select({
          wsId: runs.workspaceId,
          n: count(),
          cost: sum(runs.costUsd),
          last: max(runs.createdAt),
        })
        .from(runs)
        .where(inArray(runs.workspaceId, ids))
        .groupBy(runs.workspaceId),
      // Total cost comes from the monthly usage summary, which run retention never deletes.
      db
        .select({ wsId: usage.workspaceId, cost: sum(usage.costUsd) })
        .from(usage)
        .where(inArray(usage.workspaceId, ids))
        .groupBy(usage.workspaceId),
    ]);

    for (const row of memberRows) members.set(row.wsId, Number(row.n));
    for (const row of ownerRows) {
      if (!owners.has(row.wsId)) owners.set(row.wsId, row.email);
    }
    for (const row of instRows) {
      if (row.wsId === null) continue;
      const list = installs.get(row.wsId) ?? [];
      list.push({
        id: row.id,
        accountLogin: row.accountLogin,
        repositorySelection: row.repositorySelection,
        suspended: row.suspended,
      });
      installs.set(row.wsId, list);
    }
    for (const row of credRows) {
      const set = providers.get(row.wsId) ?? new Set<string>();
      set.add(row.provider);
      providers.set(row.wsId, set);
    }
    const usageCost = new Map(usageRows.map((row) => [row.wsId, toUsd(row.cost)]));
    for (const row of runRows) {
      runStats.set(row.wsId, { n: Number(row.n), cost: usageCost.get(row.wsId) ?? toUsd(row.cost), last: row.last });
    }
  }

  return {
    workspaces: orgRows.map((row) => {
      const stats = runStats.get(row.id);
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt.toISOString(),
        memberCount: members.get(row.id) ?? 0,
        ownerEmail: owners.get(row.id) ?? null,
        installations: installs.get(row.id) ?? [],
        providers: [...(providers.get(row.id) ?? [])].sort(),
        runsCount: stats?.n ?? 0,
        costUsdTotal: stats?.cost ?? 0,
        lastRunAt: stats?.last ? stats.last.toISOString() : null,
      };
    }),
    total: Number(totalRows[0]?.n ?? 0),
    limit,
    offset,
  };
}

import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  sum,
  type SQL,
} from 'drizzle-orm';
import * as authSchema from '../auth/schema.js';
import * as dbSchema from '../db/schema.js';
import type { AppDb } from '../db/pg-store.js';

/**
 * Read-only platform-wide queries for the operator dashboard.
 * They never select accessToken, refreshToken, idToken, password or credential ciphertext.
 */
export type AdminDb = AppDb;

export const ADMIN_MAX_PAGE_SIZE = 100;
export const ADMIN_DEFAULT_PAGE_SIZE = 50;

export interface Pagination {
  limit: number;
  offset: number;
}

export function clampPagination(options: Partial<Pagination>): Pagination {
  const rawLimit = options.limit ?? ADMIN_DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), ADMIN_MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  return { limit, offset };
}

/**
 * Turns a free-text search term into a `%term%` pattern for ILIKE, escaping LIKE wildcards so
 * `%`, `_` and `\` match literally. The pattern is always passed as a bound parameter.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Converts a numeric/sum string from Postgres into a USD number rounded to 6 decimals. */
export function toUsd(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(6)) : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OverviewResult {
  users: number;
  workspaces: number;
  installations: { linked: number; pending: number };
  repositories: number;
  reviewRuns: { total: number; last7Days: number; byStatus: Record<string, number> };
  costUsd: { allTime: number; last30Days: number };
}

export async function getOverview(db: AdminDb, now: Date = new Date()): Promise<OverviewResult> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
  const runs = dbSchema.reviewRuns;

  // All-time cost reads the monthly usage summary, which run retention never deletes (ADR-0014).
  const [users, workspaces, linked, pending, repos, totals, recentRuns, recentCost, statusRows, usage] =
    await Promise.all([
      db.select({ n: count() }).from(authSchema.user),
      db.select({ n: count() }).from(authSchema.organization),
      db
        .select({ n: count() })
        .from(dbSchema.installations)
        .where(isNotNull(dbSchema.installations.workspaceId)),
      db
        .select({ n: count() })
        .from(dbSchema.installations)
        .where(isNull(dbSchema.installations.workspaceId)),
      db.select({ n: countDistinct(runs.repoFullName) }).from(runs),
      db.select({ n: count(), cost: sum(runs.costUsd) }).from(runs),
      db.select({ n: count() }).from(runs).where(gte(runs.createdAt, sevenDaysAgo)),
      db.select({ cost: sum(runs.costUsd) }).from(runs).where(gte(runs.createdAt, thirtyDaysAgo)),
      db.select({ status: runs.status, n: count() }).from(runs).groupBy(runs.status),
      db.select({ cost: sum(dbSchema.workspaceUsageMonthly.costUsd) }).from(dbSchema.workspaceUsageMonthly),
    ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.n);
  }

  return {
    users: Number(users[0]?.n ?? 0),
    workspaces: Number(workspaces[0]?.n ?? 0),
    installations: { linked: Number(linked[0]?.n ?? 0), pending: Number(pending[0]?.n ?? 0) },
    repositories: Number(repos[0]?.n ?? 0),
    reviewRuns: {
      total: Number(totals[0]?.n ?? 0),
      last7Days: Number(recentRuns[0]?.n ?? 0),
      byStatus,
    },
    costUsd: { allTime: toUsd(usage[0]?.cost), last30Days: toUsd(recentCost[0]?.cost) },
  };
}

export interface AdminRunItem {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  repoFullName: string;
  pullNumber: number;
  status: string;
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminRunsPage extends Pagination {
  runs: AdminRunItem[];
  total: number;
}

export async function getRuns(
  db: AdminDb,
  options: Partial<Pagination> & {
    workspaceId?: string | undefined;
    /** Case-insensitive substring match on the workspace name. */
    workspaceQuery?: string | undefined;
  },
): Promise<AdminRunsPage> {
  const { limit, offset } = clampPagination(options);
  const runs = dbSchema.reviewRuns;
  const org = authSchema.organization;
  const conditions: SQL[] = [];
  if (options.workspaceId) conditions.push(eq(runs.workspaceId, options.workspaceId));
  if (options.workspaceQuery) conditions.push(ilike(org.name, containsPattern(options.workspaceQuery)));
  const filter = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRows, rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(runs)
      .leftJoin(org, eq(runs.workspaceId, org.id))
      .where(filter),
    db
      .select({
        id: runs.id,
        workspaceId: runs.workspaceId,
        workspaceName: authSchema.organization.name,
        repoFullName: runs.repoFullName,
        pullNumber: runs.pullNumber,
        status: runs.status,
        costUsd: runs.costUsd,
        createdAt: runs.createdAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .leftJoin(authSchema.organization, eq(runs.workspaceId, authSchema.organization.id))
      .where(filter)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .offset(offset),
  ]);

  return {
    runs: rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      repoFullName: r.repoFullName,
      pullNumber: r.pullNumber,
      status: r.status,
      costUsd: r.costUsd === null ? null : toUsd(r.costUsd),
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    })),
    total: Number(totalRows[0]?.n ?? 0),
    limit,
    offset,
  };
}

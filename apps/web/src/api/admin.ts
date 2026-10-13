import type { AdminMaintenanceResponse, RunRetentionResponse } from '@mergepilot/app/contract';
import { ApiClientError, fetchApi } from './client.js';

export type { AdminMaintenanceResponse, RunRetentionResponse };

/** Platform operator API (`/api/admin/*`). Every route answers 404 to non-admins. */

export interface AdminOverview {
  users: number;
  workspaces: number;
  installations: { linked: number; pending: number };
  repositories: number;
  reviewRuns: { total: number; last7Days: number; byStatus: Record<string, number> };
  costUsd: { allTime: number; last30Days: number };
}

export interface AdminPageInfo {
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUser {
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

export interface AdminUsersResponse extends AdminPageInfo {
  users: AdminUser[];
}

export interface AdminWorkspaceInstallation {
  id: number;
  accountLogin: string;
  repositorySelection: string;
  suspended: boolean;
}

export interface AdminWorkspace {
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

export interface AdminWorkspacesResponse extends AdminPageInfo {
  workspaces: AdminWorkspace[];
}

export interface AdminRun {
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

export interface AdminRunsResponse extends AdminPageInfo {
  runs: AdminRun[];
}

export interface AdminPageParams {
  limit?: number;
  offset?: number;
  workspaceId?: string;
  /** Users: case-insensitive match on name or email (server-side). */
  q?: string;
  /** Runs: case-insensitive match on workspace name (server-side). */
  workspaceQuery?: string;
}

function withQuery(path: string, params?: AdminPageParams): string {
  const search = new URLSearchParams();
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  if (params?.workspaceId) search.set('workspaceId', params.workspaceId);
  if (params?.q) search.set('q', params.q);
  if (params?.workspaceQuery) search.set('workspaceQuery', params.workspaceQuery);
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export const SOLE_OWNER_ERROR_CODE = 'sole_owner_of_shared_workspace';

export interface AdminWorkspaceRef {
  id: string;
  name: string;
}

/**
 * When a user delete was refused because the user solely owns workspaces that still have other
 * members, returns those workspaces; otherwise null.
 */
export function soleOwnedWorkspaces(err: unknown): AdminWorkspaceRef[] | null {
  if (!(err instanceof ApiClientError) || err.code !== SOLE_OWNER_ERROR_CODE) return null;
  const raw = err.details['workspaces'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { id, name } = item as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
  });
}

export const adminApi = {
  getOverview: () => fetchApi<AdminOverview>('/api/admin/overview'),
  getUsers: (params?: AdminPageParams) =>
    fetchApi<AdminUsersResponse>(withQuery('/api/admin/users', params)),
  getWorkspaces: (params?: AdminPageParams) =>
    fetchApi<AdminWorkspacesResponse>(withQuery('/api/admin/workspaces', params)),
  getRuns: (params?: AdminPageParams) =>
    fetchApi<AdminRunsResponse>(withQuery('/api/admin/runs', params)),
  deleteUser: (userId: string) =>
    fetchApi<void>(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  deleteWorkspace: (workspaceId: string) =>
    fetchApi<void>(`/api/admin/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    }),
  /** The maintenance jobs' last runs: retention (ADR-0014) and the price refresh (ADR-0016). */
  getMaintenance: () => fetchApi<AdminMaintenanceResponse>('/api/admin/maintenance'),
  /** Starts a retention cleanup now; 409 `already_running` while one runs. */
  runRetention: () => fetchApi<RunRetentionResponse>('/api/admin/maintenance/run-retention', { method: 'POST' }),
  /** Starts a model price refresh now (ADR-0016); 409 `already_running` while one runs. */
  refreshPrices: () => fetchApi<RunRetentionResponse>('/api/admin/maintenance/refresh-prices', { method: 'POST' }),
};

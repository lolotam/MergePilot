import { fetchApi } from './client.js';

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
}

function withQuery(path: string, params?: AdminPageParams): string {
  const search = new URLSearchParams();
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  if (params?.workspaceId) search.set('workspaceId', params.workspaceId);
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
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
};

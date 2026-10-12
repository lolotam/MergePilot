import type {
  MeResponse,
  Settings,
  ErrorBody,
  ReviewRun,
  RunsResponse,
  RunDetailResponse,
  RunReposResponse,
  ReviewRunResult,
  ReviewRunFinding,
  SeverityCounts,
  ApiProvider,
} from '@mergepilot/app/contract';

export type {
  ReviewRun,
  RunsResponse,
  RunDetailResponse,
  RunReposResponse,
  ReviewRunResult,
  ReviewRunFinding,
  SeverityCounts,
  ApiProvider,
};

/** GET /api/me plus the platform-operator flag (false for everyone not in MERGEPILOT_PLATFORM_ADMINS). */
export interface MeResponseWithAdmin extends MeResponse {
  isPlatformAdmin?: boolean | undefined;
}

export interface KeyItem {
  provider: ApiProvider;
  last4: string;
  createdAt: string;
  createdBy: string;
  baseUrl?: string | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  efforts: string[];
  contextWindow?: number;
}

export interface ModelsResponse {
  models: CatalogModel[];
}

export interface TestConnectionResponse {
  ok: boolean;
  ms?: number;
  model?: string;
  code?: string;
  message?: string;
}

export interface KeysResponse {
  keys: KeyItem[];
}

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

export interface InstallationsResponse {
  installations: Installation[];
}

export interface GitHubInstallation extends Installation {
  linkedWorkspaceId: string | null;
}

export interface GitHubInstallationsResponse {
  installations: GitHubInstallation[];
  installUrl: string;
}

export interface GetRunsParams {
  limit?: number | undefined;
  offset?: number | undefined;
  repo?: string[] | undefined;
  status?: string[] | undefined;
  provider?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  dir?: 'asc' | 'desc' | undefined;
}

export interface UsageResponse {
  monthCostUsd: number;
  monthlyBudgetUsd: number | null;
  monthStart: string;
}

export interface SettingsResponse {
  settings: Settings | null;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'UNKNOWN',
    public readonly status: number = 500,
    /** Extra fields of the error body beyond `code` and `message`, when the server sent any. */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || 'Request failed';
    let details: Record<string, unknown> = {};
    try {
      const data = (await res.json()) as ErrorBody;
      if (data?.error?.message) {
        const { code: bodyCode, message: bodyMessage, ...rest } = data.error as ErrorBody['error'] &
          Record<string, unknown>;
        message = bodyMessage;
        code = bodyCode;
        details = rest;
      }
    } catch {
      // Fallback to HTTP status text
    }
    throw new ApiClientError(message, code, res.status, details);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return (await res.json()) as T;
}

export const api = {
  getMe: () => fetchApi<MeResponseWithAdmin>('/api/me'),
  getSettings: (workspaceId: string) =>
    fetchApi<SettingsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`),
  updateSettings: (workspaceId: string, settings: Settings) =>
    fetchApi<SettingsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  getKeys: (workspaceId: string) =>
    fetchApi<KeysResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys`),
  saveKey: (workspaceId: string, provider: ApiProvider, apiKey: string, baseUrl?: string | undefined) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    }),
  getModels: (workspaceId: string, provider: ApiProvider, refresh = false) =>
    fetchApi<ModelsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/providers/${encodeURIComponent(provider)}/models${refresh ? '?refresh=true' : ''}`,
    ),
  testModelsUnsaved: (workspaceId: string, provider: ApiProvider, apiKey: string, baseUrl?: string | undefined) =>
    fetchApi<ModelsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/providers/${encodeURIComponent(provider)}/models`,
      {
        method: 'POST',
        body: JSON.stringify({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
      },
    ),
  testConnection: (
    workspaceId: string,
    provider: ApiProvider,
    options?: { apiKey?: string | undefined; baseUrl?: string | undefined; model?: string | undefined; effort?: string | undefined } | undefined,
  ) =>
    fetchApi<TestConnectionResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(provider)}/test`,
      {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      },
    ),
  deleteKey: (workspaceId: string, provider: ApiProvider) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
    }),
  getInstallations: (workspaceId: string) =>
    fetchApi<InstallationsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/installations`),
  linkInstallation: (workspaceId: string, installationId: number) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/installations/${installationId}/link`, {
      method: 'POST',
    }),
  getGitHubInstallations: () =>
    fetchApi<GitHubInstallationsResponse>('/api/github/installations'),
  getRuns: (workspaceId: string, params?: GetRunsParams | number) => {
    let qs = '';
    if (typeof params === 'number') {
      qs = `limit=${params}`;
    } else if (params) {
      const search = new URLSearchParams();
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.offset !== undefined) search.set('offset', String(params.offset));
      if (params.provider) search.set('provider', params.provider);
      if (params.from) search.set('from', params.from);
      if (params.to) search.set('to', params.to);
      if (params.q) search.set('q', params.q);
      if (params.sort) search.set('sort', params.sort);
      if (params.dir) search.set('dir', params.dir);
      if (params.repo) {
        for (const r of params.repo) search.append('repo', r);
      }
      if (params.status) {
        for (const s of params.status) search.append('status', s);
      }
      qs = search.toString();
    }
    return fetchApi<RunsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs${qs ? `?${qs}` : ''}`,
    );
  },
  getRun: (workspaceId: string, runId: string) =>
    fetchApi<RunDetailResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    ),
  getRunRepos: (workspaceId: string) =>
    fetchApi<RunReposResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/repos`,
    ),
  getUsage: (workspaceId: string) =>
    fetchApi<UsageResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/usage`),
  renameWorkspace: (workspaceId: string, name: string) =>
    fetchApi<{ id: string; name: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteWorkspace: (workspaceId: string, confirmName: string) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName }),
    }),
};

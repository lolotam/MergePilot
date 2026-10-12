import type { MeResponse, Settings, ErrorBody } from '@mergepilot/app/contract';

export type ApiProvider = 'anthropic' | 'openai' | 'gemini';

/** GET /api/me plus the platform-operator flag (false for everyone not in MERGEPILOT_PLATFORM_ADMINS). */
export interface MeResponseWithAdmin extends MeResponse {
  isPlatformAdmin?: boolean;
}

export interface KeyItem {
  provider: ApiProvider;
  last4: string;
  createdAt: string;
  createdBy: string;
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

export interface ReviewRun {
  id: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  status: 'queued' | 'running' | 'completed' | 'skipped' | 'failed';
  costUsd: number | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunsResponse {
  runs: ReviewRun[];
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
  saveKey: (workspaceId: string, provider: ApiProvider, apiKey: string) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
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
  getRuns: (workspaceId: string, limit = 50) =>
    fetchApi<RunsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs?limit=${limit}`),
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

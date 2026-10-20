import type {
  MeResponse,
  Settings,
  ErrorBody,
  ReviewRun,
  RunsResponse,
  RunGroup,
  RunGroupsResponse,
  RunDetailResponse,
  RunReposResponse,
  ReviewRunResult,
  ReviewRunFinding,
  SeverityCounts,
  ApiProvider,
  KeyProvider,
  JudgeProvidersResponse,
  BackupPreview,
  BackupSection,
  ExportBackupBody,
  SubscriptionLogin,
  SubscriptionProvider,
  SubscriptionAvailability,
} from '@mergepilot/app/contract';

export type { PricesResponse } from '@mergepilot/app/contract';
export type { SubscriptionAvailability, SubscriptionLogin, SubscriptionLoginErrorCode, SubscriptionProvider } from '@mergepilot/app/contract';
export type {
  BackupPreview,
  BackupSection,
  ExportBackupBody,
  KeyProvider,
  JudgeProvidersResponse,
  ReviewRun,
  RunGroup,
  RunGroupsResponse,
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

export interface KeySlotItem {
  id: string;
  position: number;
  last4: string;
  createdAt: string;
  lastTestStatus: 'valid' | 'invalid' | 'quota-exhausted' | null;
  lastTestedAt: string | null;
}

export type ProviderAuthMethod = 'subscription' | 'api-key';

export interface KeyItem {
  provider: KeyProvider;
  authMethod?: 'api-key' | 'subscription' | 'unknown';
  last4: string;
  createdAt: string;
  createdBy: string;
  baseUrl?: string | null;
  hasSubscription?: boolean | undefined;
  defaultMethod?: ProviderAuthMethod | undefined;
  /** ISO time the provider refused the subscription refresh; sign in again. */
  signInRequiredAt?: string | undefined;
  /** Present for key-list providers. Never includes the secret. */
  keys?: KeySlotItem[] | undefined;
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
  quotaStatus?: 'valid' | 'invalid' | 'quota-exhausted' | undefined;
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

/** The dashboard error body (`{ error: { code, message, ...details } }`) as an ApiClientError. */
async function toApiClientError(res: Response): Promise<ApiClientError> {
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
  return new ApiClientError(message, code, res.status, details);
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
    throw await toApiClientError(res);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return (await res.json()) as T;
}

/**
 * POST /backup/export: the server seals the keys with the passphrase and answers the file as an
 * attachment; this returns it as a Blob with the server's file name (ADR-0018).
 */
export async function downloadBackup(
  workspaceId: string,
  body: ExportBackupBody,
): Promise<{ filename: string; blob: Blob }> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/backup/export`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiClientError(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'mergepilot-settings.json';
  return { filename, blob: await res.blob() };
}

function runsQueryString(params: GetRunsParams | undefined, groupBy?: 'pr'): string {
  const search = new URLSearchParams();
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  if (params?.provider) search.set('provider', params.provider);
  if (params?.from) search.set('from', params.from);
  if (params?.to) search.set('to', params.to);
  if (params?.q) search.set('q', params.q);
  if (params?.sort) search.set('sort', params.sort);
  if (params?.dir) search.set('dir', params.dir);
  for (const r of params?.repo ?? []) search.append('repo', r);
  for (const st of params?.status ?? []) search.append('status', st);
  if (groupBy) search.set('groupBy', groupBy);
  return search.toString();
}

export const api = {
  getSubscriptionAvailability: (workspaceId: string) =>
    fetchApi<SubscriptionAvailability>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions`),
  startSubscription: (workspaceId: string, provider: SubscriptionProvider, acknowledgedTerms = false) =>
    fetchApi<SubscriptionLogin>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions/${provider}`, {
      method: 'POST',
      body: JSON.stringify(acknowledgedTerms ? { acknowledgedTerms: true } : {}),
    }),
  getSubscriptionLogin: (workspaceId: string, id: string) =>
    fetchApi<SubscriptionLogin>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions/sessions/${encodeURIComponent(id)}`),
  answerSubscription: (workspaceId: string, id: string, promptId: string, value: string) =>
    fetchApi<SubscriptionLogin>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST', body: JSON.stringify({ promptId, value }),
    }),
  finishSubscription: (workspaceId: string, id: string) =>
    fetchApi<SubscriptionLogin>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions/sessions/${encodeURIComponent(id)}/finish`, { method: 'POST', body: '{}' }),
  cancelSubscription: (workspaceId: string, id: string) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/subscriptions/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  saveKey: (workspaceId: string, provider: KeyProvider, apiKey: string, baseUrl?: string | undefined) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    }),
  /** Replaces the ordered list. Sends `apiKeys` only, never mixed with `apiKey`. */
  saveKeys: (workspaceId: string, provider: KeyProvider, apiKeys: readonly string[]) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKeys: [...apiKeys] }),
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
    options?: { apiKey?: string | undefined; keyId?: string | undefined; baseUrl?: string | undefined; model?: string | undefined; effort?: string | undefined } | undefined,
  ) =>
    fetchApi<TestConnectionResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/credentials/${encodeURIComponent(provider)}/test`,
      {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      },
    ),
  deleteKey: (workspaceId: string, provider: KeyProvider) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}`, {
      method: 'DELETE',
    }),
  setProviderDefaultMethod: (workspaceId: string, provider: KeyProvider, method: ProviderAuthMethod) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}/default-method`, {
      method: 'PUT',
      body: JSON.stringify({ method }),
    }),
  disconnectSubscription: (workspaceId: string, provider: KeyProvider) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(provider)}/subscription`, {
      method: 'DELETE',
    }),
  /** The fixed Jev-only model table (ADR-0015). */
  getJudgeProviders: (workspaceId: string) =>
    fetchApi<JudgeProvidersResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/judge/providers`),
  /** One tiny Jev question with the stored key, or an unsaved `apiKey` (never stored). */
  testJudge: (workspaceId: string, body: { provider: string; model?: string | undefined; apiKey?: string | undefined }) =>
    fetchApi<TestConnectionResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/judge/test`, {
      method: 'POST',
      body: JSON.stringify(body),
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
    const qs = typeof params === 'number' ? `limit=${params}` : runsQueryString(params);
    return fetchApi<RunsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs${qs ? `?${qs}` : ''}`,
    );
  },
  /** The runs list grouped by PR (paging and sorting over PR groups). */
  getRunGroups: (workspaceId: string, params?: GetRunsParams) =>
    fetchApi<RunGroupsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs?${runsQueryString(params, 'pr')}`,
    ),
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
  /** Owner only. `dryRun` returns the preview and writes nothing (ADR-0018). */
  restoreBackup: (
    workspaceId: string,
    body: { file: unknown; passphrase?: string | undefined; dryRun: boolean; sections: BackupSection[] },
  ) =>
    fetchApi<BackupPreview>(`/api/workspaces/${encodeURIComponent(workspaceId)}/backup/restore`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteWorkspace: (workspaceId: string, confirmName: string) =>
    fetchApi<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName }),
    }),
};

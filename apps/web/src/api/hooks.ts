import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, SettingsUpdate } from '@mergepilot/app/contract';
import { api, ApiClientError, type GetRunsParams, type KeyProvider } from './client.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.getMe(),
    staleTime: 10_000,
  });
}

export function useSettingsQuery(workspaceId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'settings'],
    queryFn: () => api.getSettings(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function useUpdateSettingsMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (settings: SettingsUpdate) => api.updateSettings(workspaceId, settings),
    onSuccess: (saved) => {
      queryClient.setQueryData(['workspaces', workspaceId, 'settings'], saved);
      showToast(t('settingsSavedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'settings'] });
      // The main bot's name and logo are saved with the settings (ADR-0017).
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'bots'] });
      // The main bot's skill choice changes the skills' "used by" (ADR-0034).
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'skills'] });
    },
    onError: async (err: Error) => {
      showToast(err.message || t('error'), 'error');
      if (err instanceof ApiClientError && err.code === 'settings_conflict') {
        await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'settings'] });
      }
    },
  });
}

export function useKeysQuery(workspaceId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'keys'],
    queryFn: () => api.getKeys(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function useSaveKeyMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: ({
      provider,
      apiKey,
      baseUrl,
      apiKeys,
    }: {
      provider: KeyProvider;
      apiKey: string;
      baseUrl?: string | undefined;
      apiKeys?: readonly string[] | undefined;
    }) =>
      apiKeys && apiKeys.length > 0
        ? api.saveKeys(workspaceId, provider, apiKeys)
        : api.saveKey(workspaceId, provider, apiKey, baseUrl),
    onSuccess: () => {
      showToast(t('keySavedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'prices'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useSetProviderDefaultMethodMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: ({ provider, method }: { provider: KeyProvider; method: 'subscription' | 'api-key' }) =>
      api.setProviderDefaultMethod(workspaceId, provider, method),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useDisconnectSubscriptionMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (provider: KeyProvider) => api.disconnectSubscription(workspaceId, provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useDeleteKeyMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (provider: KeyProvider) => api.deleteKey(workspaceId, provider),
    onSuccess: () => {
      showToast(t('keyDeletedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'providers'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'prices'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useInstallationsQuery(workspaceId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'installations'],
    queryFn: () => api.getInstallations(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function useLinkInstallationMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (installationId: number) => api.linkInstallation(workspaceId, installationId),
    onSuccess: () => {
      showToast(t('installationLinkedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'installations'] });
      queryClient.invalidateQueries({ queryKey: ['github', 'installations'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useGitHubInstallationsQuery(enabled = true) {
  return useQuery({
    queryKey: ['github', 'installations'],
    queryFn: () => api.getGitHubInstallations(),
    enabled,
  });
}

export function useRunsQuery(workspaceId: string, params?: GetRunsParams | number) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', params],
    queryFn: () => api.getRuns(workspaceId, params),
    enabled: Boolean(workspaceId),
  });
}

/** How often a list or detail showing a queued/running run asks the server again. */
export const ACTIVE_RUN_POLL_MS = 5_000;

function isActiveRunStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'running';
}

/** The runs page list, grouped by PR. */
export function useRunGroupsQuery(workspaceId: string, params: GetRunsParams) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', 'groups', params],
    queryFn: () => api.getRunGroups(workspaceId, params),
    enabled: Boolean(workspaceId),
    // While a shown run is queued/running, poll so its live timer ends at the stored duration.
    refetchInterval: (query) =>
      query.state.data?.groups.some((g) => g.runs.some((r) => isActiveRunStatus(r.status))) ? ACTIVE_RUN_POLL_MS : false,
  });
}

export function useRunDetailQuery(workspaceId: string, runId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', runId, 'detail'],
    queryFn: () => api.getRun(workspaceId, runId),
    enabled: Boolean(workspaceId && runId),
    refetchInterval: (query) => (isActiveRunStatus(query.state.data?.run.status) ? ACTIVE_RUN_POLL_MS : false),
  });
}

export function useRunReposQuery(workspaceId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', 'repos'],
    queryFn: () => api.getRunRepos(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function useUsageQuery(workspaceId: string) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'usage'],
    queryFn: () => api.getUsage(workspaceId),
    enabled: Boolean(workspaceId),
  });
}

export function useRenameWorkspaceMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (name: string) => api.renameWorkspace(workspaceId, name),
    onSuccess: () => {
      showToast(t('workspaceRenamedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useDeleteWorkspaceMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (confirmName: string) => api.deleteWorkspace(workspaceId, confirmName),
    onSuccess: async () => {
      // Drop the deleted workspace from the cache before the caller navigates to `/`, so the root
      // redirect cannot send the user back to it while /api/me is refetched.
      queryClient.setQueryData<MeResponse>(['me'], (prev) =>
        prev ? { ...prev, workspaces: prev.workspaces.filter((w) => w.id !== workspaceId) } : prev,
      );
      queryClient.removeQueries({ queryKey: ['workspaces', workspaceId] });
      showToast(t('workspaceDeletedSuccess'), 'success');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings } from '@mergepilot/app/contract';
import { api, type ApiProvider } from './client.js';
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
    mutationFn: (settings: Settings) => api.updateSettings(workspaceId, settings),
    onSuccess: () => {
      showToast(t('settingsSavedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'settings'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
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
    mutationFn: ({ provider, apiKey }: { provider: ApiProvider; apiKey: string }) =>
      api.saveKey(workspaceId, provider, apiKey),
    onSuccess: () => {
      showToast(t('keySavedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
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
    mutationFn: (provider: ApiProvider) => api.deleteKey(workspaceId, provider),
    onSuccess: () => {
      showToast(t('keyDeletedSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'keys'] });
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

export function useRunsQuery(workspaceId: string, limit = 50) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', limit],
    queryFn: () => api.getRuns(workspaceId, limit),
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

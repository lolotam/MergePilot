import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoColorKey, Settings } from '@mergepilot/app/contract';
import { fetchApi, type SettingsResponse } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';

const settingsKey = (workspaceId: string) => ['workspaces', workspaceId, 'settings'];
const settingsUrl = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/settings`;

/** The workspace settings (same cache entry as useSettingsQuery). */
export function useWorkspaceSettings(workspaceId: string) {
  return useQuery({
    queryKey: settingsKey(workspaceId),
    queryFn: () => fetchApi<SettingsResponse>(settingsUrl(workspaceId)),
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
  });
}

export interface SettingsPatch {
  runRetentionDays?: Settings['runRetentionDays'];
  repoColors?: Record<string, RepoColorKey>;
  /** The Jev judge (ADR-0015); null turns it off and clears it. */
  judge?: Settings['judge'];
  /** Manual model prices (ADR-0016): always the whole list. */
  priceOverrides?: Settings['priceOverrides'];
}

/**
 * Saves one or two settings fields through PUT settings (the server keeps every field left out).
 * The cache is updated at once, so the runs table recolors right away, and rolled back on error.
 * Needs saved settings: the PUT requires provider, model and language.
 */
export function usePatchSettings(workspaceId: string, successKey: I18nKey) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  const key = settingsKey(workspaceId);

  return useMutation({
    mutationFn: async (patch: SettingsPatch) => {
      const current = queryClient.getQueryData<SettingsResponse>(key)?.settings;
      if (!current) throw new Error(t('retentionNeedsSettings'));
      const body = { provider: current.provider, model: current.model, language: current.language, ...patch };
      return fetchApi<SettingsResponse>(settingsUrl(workspaceId), { method: 'PUT', body: JSON.stringify(body) });
    },
    onMutate: async (patch: SettingsPatch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SettingsResponse>(key);
      if (previous?.settings) {
        queryClient.setQueryData<SettingsResponse>(key, { settings: { ...previous.settings, ...patch } });
      }
      return { previous };
    },
    onError: (err: Error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      showToast(err.message || t('error'), 'error');
    },
    onSuccess: () => {
      showToast(t(successKey), 'success');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** The repo -> color map with one repo changed (`null` = back to Auto). */
export function withRepoColor(
  colors: Record<string, RepoColorKey> | undefined,
  repo: string,
  color: RepoColorKey | null,
): Record<string, RepoColorKey> {
  const next = { ...(colors ?? {}) };
  if (color) next[repo] = color;
  else delete next[repo];
  return next;
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoColorKey, Settings, SettingsBase } from '@mergepilot/app/contract';
import { fetchApi, type SettingsResponse } from '../api/client.js';
import { settingsSaveScopeId } from '../api/hooks.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';
import { withSettingsBase } from './settings-base.js';

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
  /** The reviewer panel output (ADR-0017). */
  panelMode?: Settings['panelMode'];
  panelMinAgreement?: Settings['panelMinAgreement'];
}

export type SettingsPatchRequest = SettingsPatch & Pick<Settings, 'provider' | 'model' | 'language'> & { base: SettingsBase };

/**
 * Saves one or two settings fields through PUT settings (the server keeps every field left out).
 * The cache is updated at once, so the runs table recolors right away, and rolled back on error.
 * Needs saved settings: the PUT requires provider, model and language.
 * The saves of one workspace run one after another (the mutation scope), so two quick saves
 * reach the server in the order the user made them.
 */
export function usePatchSettings(workspaceId: string, successKey: I18nKey) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  const key = settingsKey(workspaceId);

  return useMutation({
    scope: { id: settingsSaveScopeId(workspaceId) },
    mutationFn: async (body: SettingsPatchRequest) => {
      return fetchApi<SettingsResponse>(settingsUrl(workspaceId), { method: 'PUT', body: JSON.stringify(body) });
    },
    onMutate: async (body: SettingsPatchRequest) => {
      await queryClient.cancelQueries({ queryKey: key });
      const { base: _base, provider: _provider, model: _model, language: _language, ...patch } = body;
      const previous = queryClient.getQueryData<SettingsResponse>(key);
      if (previous?.settings) {
        queryClient.setQueryData<SettingsResponse>(key, { ...previous, settings: { ...previous.settings, ...patch } });
      }
      return { previous };
    },
    onError: (err: Error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      showToast(err.message || t('error'), 'error');
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<SettingsResponse>(key, saved);
      showToast(t(successKey), 'success');
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** Builds a card save from the same snapshot used to derive its changed fields. */
export function settingsPatch(snapshot: Settings, patch: SettingsPatch): SettingsPatchRequest {
  return withSettingsBase({
    provider: snapshot.provider, model: snapshot.model, language: snapshot.language, ...patch,
  }, snapshot);
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

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, downloadBackup, type BackupSection, type ExportBackupBody } from '../api/client.js';
import { refreshCredentialQueries } from '../api/credential-queries.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

/** Hands a Blob to the browser as a file download. */
function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Downloads the settings backup; the server seals the keys with the passphrase (ADR-0018). */
export function useExportBackup(workspaceId: string) {
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: async (body: ExportBackupBody) => {
      const { filename, blob } = await downloadBackup(workspaceId, body);
      saveBlob(filename, blob);
    },
    onSuccess: () => showToast(t('backupDownloaded'), 'success'),
    onError: (err: Error) => showToast(err.message || t('error'), 'error'),
  });
}

export interface RestoreVariables {
  file: unknown;
  passphrase?: string | undefined;
  dryRun: boolean;
  sections: BackupSection[];
}

/** Previews (dryRun) or applies a restore; errors are shown inline by the dialog. */
export function useRestoreBackup(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (vars: RestoreVariables) => api.restoreBackup(workspaceId, vars),
    onSuccess: async (applied, vars) => {
      if (vars.dryRun) return;
      const credentialsRestored = applied.sections.includes('credentials');
      // Credentials refresh their own queries. Cancel other reads even if they have no cached data.
      const remaining = {
        queryKey: ['workspaces', workspaceId],
        predicate: (query: { queryKey: readonly unknown[] }) =>
          !credentialsRestored || (query.queryKey[2] !== 'keys' && query.queryKey[2] !== 'providers'),
      };
      await Promise.all([
        queryClient.cancelQueries(remaining),
        credentialsRestored ? refreshCredentialQueries(queryClient, workspaceId) : undefined,
      ]);
      showToast(t('backupRestored'), 'success');
      await queryClient.invalidateQueries(remaining);
    },
  });
}

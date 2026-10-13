import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, downloadBackup, type BackupSection, type ExportBackupBody } from '../api/client.js';
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
    onSuccess: async (_preview, vars) => {
      if (vars.dryRun) return;
      showToast(t('backupRestored'), 'success');
      // Settings, bots and keys all live under this workspace's queries.
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
    },
  });
}

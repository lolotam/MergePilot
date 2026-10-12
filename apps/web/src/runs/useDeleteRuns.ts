import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeleteRunsRequest, DeleteRunsResponse } from '@mergepilot/app/contract';
import { ApiClientError, fetchApi } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

export async function deleteRuns(workspaceId: string, body: DeleteRunsRequest): Promise<DeleteRunsResponse> {
  return fetchApi<DeleteRunsResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/delete`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Bulk delete; on success (or a count mismatch) the runs lists refetch. */
export function useDeleteRunsMutation(workspaceId: string, onDone: () => void) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'runs'] });

  return useMutation({
    mutationFn: (body: DeleteRunsRequest) => deleteRuns(workspaceId, body),
    onSuccess: (data) => {
      showToast(t('deleteRunsSuccess', { n: data.deleted }), 'success');
      onDone();
      void refresh();
    },
    onError: (err: Error) => {
      const changed = err instanceof ApiClientError && err.code === 'count_mismatch';
      showToast(changed ? t('deleteRunsCountChanged') : err.message || t('error'), 'error');
      if (changed) {
        onDone();
        void refresh();
      }
    },
  });
}

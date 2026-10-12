import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RetryFailedBody,
  RetryFailedDryRunResponse,
  RetryFailedResponse,
  RetryRunResponse,
} from '@mergepilot/app/contract';
import { fetchApi } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

export async function retryRun(workspaceId: string, runId: string): Promise<RetryRunResponse> {
  return fetchApi<RetryRunResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/retry`,
    { method: 'POST' },
  );
}

export async function retryFailedRuns(
  workspaceId: string,
  body?: RetryFailedBody,
): Promise<RetryFailedResponse> {
  return fetchApi<RetryFailedResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/retry-failed`,
    {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    },
  );
}

/** Asks the server what "retry all failed" would queue for these filters; queues nothing. */
export async function previewRetryFailedRuns(
  workspaceId: string,
  filters: RetryFailedBody,
): Promise<RetryFailedDryRunResponse> {
  return fetchApi<RetryFailedDryRunResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/retry-failed`,
    {
      method: 'POST',
      body: JSON.stringify({ ...filters, dryRun: true }),
    },
  );
}

/** Fresh preview each time the confirm dialog opens, so its count matches the real call. */
export function useRetryFailedPreview(workspaceId: string, filters: RetryFailedBody, enabled: boolean) {
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'runs', 'retry-failed-preview', filters],
    queryFn: () => previewRetryFailedRuns(workspaceId, filters),
    enabled: enabled && Boolean(workspaceId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useRetryRunMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (runId: string) => retryRun(workspaceId, runId),
    onSuccess: (_data, runId) => {
      showToast(t('retryRunSuccess'), 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'runs'] });
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'runs', runId, 'detail'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useRetryFailedRunsMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (body?: RetryFailedBody) => retryFailedRuns(workspaceId, body),
    onSuccess: (data) => {
      const msg = t('retryAllFailedSuccess')
        .replace('{queued}', String(data.queued))
        .replace('{skipped}', String(data.skipped.length));
      showToast(msg, 'success');
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'runs'] });
    },
    onError: (err: Error) => {
      showToast(err.message || t('error'), 'error');
    },
  });
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { adminApi, soleOwnedWorkspaces, type AdminPageParams } from '../api/admin.js';
import { ApiClientError } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_SEARCH_DEBOUNCE_MS = 300;

/** Returns `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number = ADMIN_SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useAdminOverviewQuery() {
  return useQuery({ queryKey: ['admin', 'overview'], queryFn: () => adminApi.getOverview() });
}

export function useAdminUsersQuery(offset: number, q: string) {
  return useQuery({
    queryKey: ['admin', 'users', offset, q],
    queryFn: () => adminApi.getUsers({ limit: ADMIN_PAGE_SIZE, offset, ...(q ? { q } : {}) }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminWorkspacesQuery(params: AdminPageParams) {
  return useQuery({
    queryKey: ['admin', 'workspaces', params.limit, params.offset],
    queryFn: () => adminApi.getWorkspaces(params),
    placeholderData: keepPreviousData,
  });
}

export function useAdminRunsQuery(offset: number, workspaceQuery: string) {
  return useQuery({
    queryKey: ['admin', 'runs', offset, workspaceQuery],
    queryFn: () =>
      adminApi.getRuns({
        limit: ADMIN_PAGE_SIZE,
        offset,
        ...(workspaceQuery ? { workspaceQuery } : {}),
      }),
    placeholderData: keepPreviousData,
  });
}

function useAdminDelete(run: (id: string) => Promise<void>, successKey: 'userDeletedSuccess' | 'workspaceDeletedSuccess') {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      showToast(t(successKey), 'success');
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (err: Error) => {
      // The Users tab explains this refusal inline, with the workspaces involved.
      if (soleOwnedWorkspaces(err) !== null) return;
      showToast(err.message || t('error'), 'error');
    },
  });
}

export function useAdminDeleteUserMutation() {
  return useAdminDelete((userId) => adminApi.deleteUser(userId), 'userDeletedSuccess');
}

export function useAdminDeleteWorkspaceMutation() {
  return useAdminDelete((workspaceId) => adminApi.deleteWorkspace(workspaceId), 'workspaceDeletedSuccess');
}

/** The retention job's last run; polls every 3 s while it is still running. */
export function useAdminMaintenanceQuery() {
  return useQuery({
    queryKey: ['admin', 'maintenance'],
    queryFn: () => adminApi.getMaintenance(),
    refetchInterval: (query) => {
      const last = query.state.data?.retention.lastRun;
      return last && last.finishedAt === null ? 3000 : false;
    },
  });
}

export function useRunRetentionMutation() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: () => adminApi.runRetention(),
    onSuccess: () => {
      showToast(t('adminRetentionStarted'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'maintenance'] });
    },
    onError: (err: Error) => {
      const busy = err instanceof ApiClientError && err.code === 'already_running';
      showToast(busy ? t('adminRetentionBusy') : err.message || t('error'), 'error');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'maintenance'] });
    },
  });
}

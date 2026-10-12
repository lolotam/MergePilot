import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, type AdminPageParams } from '../api/admin.js';
import { useToast } from '../components/Toast.js';
import { useI18n } from '../i18n/context.js';

export const ADMIN_PAGE_SIZE = 50;

export function useAdminOverviewQuery() {
  return useQuery({ queryKey: ['admin', 'overview'], queryFn: () => adminApi.getOverview() });
}

export function useAdminUsersQuery(offset: number) {
  return useQuery({
    queryKey: ['admin', 'users', offset],
    queryFn: () => adminApi.getUsers({ limit: ADMIN_PAGE_SIZE, offset }),
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

export function useAdminRunsQuery(offset: number, workspaceId: string) {
  return useQuery({
    queryKey: ['admin', 'runs', offset, workspaceId],
    queryFn: () =>
      adminApi.getRuns({ limit: ADMIN_PAGE_SIZE, offset, ...(workspaceId ? { workspaceId } : {}) }),
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

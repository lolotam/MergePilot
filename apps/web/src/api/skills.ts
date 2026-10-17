import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillResponse, SkillsResponse, SkillSummary } from '@mergepilot/app/contract';
import { fetchApi } from './client.js';

export type { SkillResponse, SkillsResponse, SkillSummary };

// Review skills (ADR-0034): Markdown a workspace admin uploads; each bot may use one.
// The hooks call fetchApi directly (like bots.ts), so tests can stub the server in one place.

export const skillsQueryKey = (workspaceId: string) => ['workspaces', workspaceId, 'skills'] as const;
const skillQueryKey = (workspaceId: string, skillId: string) => [...skillsQueryKey(workspaceId), skillId] as const;
const skillsUrl = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/skills`;
const skillUrl = (workspaceId: string, skillId: string) => `${skillsUrl(workspaceId)}/${encodeURIComponent(skillId)}`;

export const skillsApi = {
  /** GET (member): the skills without content, and the workspace limits. */
  list: (workspaceId: string) => fetchApi<SkillsResponse>(skillsUrl(workspaceId)),
  /** GET (member): one skill with its content. */
  get: (workspaceId: string, skillId: string) => fetchApi<SkillResponse>(skillUrl(workspaceId, skillId)),
  /** POST (admin): 201. 409 `skill_name_taken` / `skill_limit`; 400 for the content checks. */
  create: (workspaceId: string, body: { name: string; content: string }) =>
    fetchApi<SkillResponse>(skillsUrl(workspaceId), { method: 'POST', body: JSON.stringify(body) }),
  /** PUT (admin): fields left out keep their value. */
  update: (workspaceId: string, skillId: string, body: { name?: string; content?: string }) =>
    fetchApi<SkillResponse>(skillUrl(workspaceId, skillId), { method: 'PUT', body: JSON.stringify(body) }),
  /** DELETE (admin): 204; the bots that used it fall back to Default. */
  remove: (workspaceId: string, skillId: string) => fetchApi<void>(skillUrl(workspaceId, skillId), { method: 'DELETE' }),
};

/** The workspace's skills (no content) and limits. */
export function useSkillsQuery(workspaceId: string) {
  return useQuery({
    queryKey: skillsQueryKey(workspaceId),
    queryFn: () => skillsApi.list(workspaceId),
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
  });
}

/** One skill with its content, fetched only while `enabled` (the preview is open). */
export function useSkillContentQuery(workspaceId: string, skillId: string, enabled: boolean) {
  return useQuery({
    queryKey: skillQueryKey(workspaceId, skillId),
    queryFn: () => skillsApi.get(workspaceId, skillId),
    enabled: enabled && Boolean(workspaceId),
  });
}

/** Errors are left to the caller, which shows them inline by code. */
export function useCreateSkillMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; content: string }) => skillsApi.create(workspaceId, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceId) }),
  });
}

export function useUpdateSkillMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, body }: { skillId: string; body: { name?: string; content?: string } }) =>
      skillsApi.update(workspaceId, skillId, body),
    onSuccess: (res, { skillId }) => {
      if (res?.skill) queryClient.setQueryData(skillQueryKey(workspaceId, skillId), res);
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceId) });
    },
  });
}

/**
 * Deleting a skill sets its bots to Default with the deleted-skill note on the server, so the
 * settings and bots refetch too (every query of the workspace).
 */
export function useDeleteSkillMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) => skillsApi.remove(workspaceId, skillId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] }),
  });
}

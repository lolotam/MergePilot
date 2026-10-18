import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotLogo, BotsResponse, PanelMode, ReviewerBotDto, ReviewerBotInput } from '@mergepilot/app/contract';
import { fetchApi } from './client.js';
import { skillsQueryKey } from './skills.js';

export type { BotLogo, BotsResponse, PanelMode, ReviewerBotDto, ReviewerBotInput };

// The reviewer panel API (ADR-0017): the main bot (slot 1, from the settings) and extra bots 2-5.
// The hooks call fetchApi directly (like useSettingsPatch), so tests can stub the server in one place.

export const botsQueryKey = (workspaceId: string) => ['workspaces', workspaceId, 'bots'] as const;
const botsUrl = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/bots`;
const botUrl = (workspaceId: string, slot: number) => `${botsUrl(workspaceId)}/${slot}`;

export const botsApi = {
  list: (workspaceId: string) => fetchApi<BotsResponse>(botsUrl(workspaceId)),
  /** PUT (admin) /bots/:slot (2-5): creates or replaces the extra bot. 409 `bot_name_taken`. */
  save: (workspaceId: string, slot: number, input: ReviewerBotInput) =>
    fetchApi<{ bot: ReviewerBotDto }>(botUrl(workspaceId, slot), { method: 'PUT', body: JSON.stringify(input) }),
  /** DELETE (admin) /bots/:slot: 204, or 404 when the slot is empty. */
  remove: (workspaceId: string, slot: number) => fetchApi<void>(botUrl(workspaceId, slot), { method: 'DELETE' }),
};

/** The main bot, the extra bots by slot, the panel settings and the logo keys. */
export function useBotsQuery(workspaceId: string) {
  return useQuery({
    queryKey: botsQueryKey(workspaceId),
    queryFn: () => botsApi.list(workspaceId),
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
  });
}

/** Puts the saved bot into the cached list (sorted by slot), so its tab shows before the refetch. */
function withBot(prev: BotsResponse | undefined, bot: ReviewerBotDto): BotsResponse | undefined {
  if (!prev?.bots) return prev;
  const bots = [...prev.bots.filter((b) => b.slot !== bot.slot), bot].sort((a, b) => a.slot - b.slot);
  return { ...prev, bots };
}

/**
 * Creates or replaces an extra bot. Errors are left to the caller, which shows them inline
 * (409 `bot_name_taken`, 400 validation).
 */
export function useSaveBotMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slot, input }: { slot: number; input: ReviewerBotInput }) => botsApi.save(workspaceId, slot, input),
    onSuccess: (res) => {
      if (res?.bot) queryClient.setQueryData<BotsResponse>(botsQueryKey(workspaceId), (prev) => withBot(prev, res.bot));
      void queryClient.invalidateQueries({ queryKey: botsQueryKey(workspaceId) });
      // A bot's skill choice changes the skills' "used by" (ADR-0034).
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceId) });
    },
  });
}

export function useDeleteBotMutation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) => botsApi.remove(workspaceId, slot),
    onSuccess: (_res, slot) => {
      queryClient.setQueryData<BotsResponse>(botsQueryKey(workspaceId), (prev) =>
        prev?.bots ? { ...prev, bots: prev.bots.filter((b) => b.slot !== slot) } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: botsQueryKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceId) });
    },
  });
}

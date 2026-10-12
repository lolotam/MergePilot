import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import type { MeResponse } from '@mergepilot/app/contract';
import { api } from './client.js';
import { ACTIVE_RUN_POLL_MS, useDeleteWorkspaceMutation, useMeQuery, useRunGroupsQuery } from './hooks.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';

const user = { id: 'u1', email: 'owner@test.local', name: 'Owner', image: null, githubLinked: true };

function meWith(ids: string[]): MeResponse {
  return {
    user,
    workspaces: ids.map((id) => ({ id, name: `Workspace ${id}`, slug: id, role: 'owner' as const })),
  } as MeResponse;
}

describe('useDeleteWorkspaceMutation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the deleted workspace from ["me"] and finishes the refetch before resolving', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['me'], meWith(['ws-1', 'ws-2']));
    queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], { settings: null });

    vi.spyOn(api, 'deleteWorkspace').mockResolvedValue(undefined);
    let resolveRefetch: (value: MeResponse) => void = () => {};
    const getMe = vi.spyOn(api, 'getMe').mockImplementation(
      () => new Promise<MeResponse>((resolve) => {
        resolveRefetch = resolve;
      }),
    );

    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          I18nProvider,
          { initialLanguage: 'en' },
          React.createElement(ToastProvider, null, children),
        ),
      );

    const { result } = renderHook(
      () => ({ me: useMeQuery(), del: useDeleteWorkspaceMutation('ws-1') }),
      { wrapper },
    );

    let settled = false;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.del.mutateAsync('Workspace ws-1').then(() => {
        settled = true;
      });
    });

    // Cache is updated synchronously, before the server refetch returns.
    await waitFor(() => {
      expect(queryClient.getQueryData<MeResponse>(['me'])?.workspaces.map((w) => w.id)).toEqual(['ws-2']);
    });
    expect(queryClient.getQueryData(['workspaces', 'ws-1', 'settings'])).toBeUndefined();
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(settled).toBe(false);

    await act(async () => {
      resolveRefetch(meWith(['ws-2']));
      await pending;
    });
    expect(settled).toBe(true);
    expect(queryClient.getQueryData<MeResponse>(['me'])?.workspaces.map((w) => w.id)).toEqual(['ws-2']);
  });
});

describe('useRunGroupsQuery polling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('polls while a run is active and stops once every run has finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const group = (status: string) => ({
      groups: [{ repoFullName: 'o/r', pullNumber: 1, runs: [{ id: 'r1', status }] }],
      total: 1,
      totalRuns: 1,
    });
    const getRunGroups = vi
      .spyOn(api, 'getRunGroups')
      .mockResolvedValueOnce(group('running') as never)
      .mockResolvedValue(group('completed') as never);
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useRunGroupsQuery('ws-1', {}), { wrapper });
    await waitFor(() => expect(getRunGroups).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_POLL_MS);
    });
    await waitFor(() => expect(getRunGroups).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_POLL_MS * 3);
    });
    expect(getRunGroups).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import type { MeResponse } from '@mergepilot/app/contract';
import { api, ApiClientError, type SettingsResponse } from './client.js';
import {
  ACTIVE_RUN_POLL_MS, useDeleteWorkspaceMutation, useMeQuery, useRunGroupsQuery, useSettingsQuery, useUpdateSettingsMutation,
} from './hooks.js';
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

describe('useUpdateSettingsMutation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settingsKey = ['workspaces', 'ws-1', 'settings'];
  const stored = (exploreEnabled: boolean) => ({ settings: { exploreEnabled } }) as unknown as SettingsResponse;
  const body = { provider: 'openrouter', model: 'm', language: 'en', exploreEnabled: true } as const;

  function wrapperFor(queryClient: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(I18nProvider, { initialLanguage: 'en' }, React.createElement(ToastProvider, null, children)),
      );
  }

  it('puts the settings the save answers into the cache before any refetch', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(settingsKey, stored(false));
    vi.spyOn(api, 'updateSettings').mockResolvedValue(stored(true));

    const { result } = renderHook(() => useUpdateSettingsMutation('ws-1'), { wrapper: wrapperFor(queryClient) });
    await act(() => result.current.mutateAsync(body));

    expect(queryClient.getQueryData(settingsKey)).toEqual(stored(true));
  });

  it.each([
    ['a 409', new ApiClientError('changed', 'settings_conflict', 409)],
    ['a 5xx', new ApiClientError('bad gateway', 'internal', 502)],
    ['a lost answer', new TypeError('Failed to fetch')],
  ])('refetches the settings after %s, whose write may have happened', async (_name, error) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getSettings = vi.spyOn(api, 'getSettings').mockResolvedValue(stored(true));
    vi.spyOn(api, 'updateSettings').mockRejectedValue(error);
    const { result } = renderHook(
      () => ({ query: useSettingsQuery('ws-1'), save: useUpdateSettingsMutation('ws-1') }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(() => result.current.save.mutateAsync(body).catch(() => undefined));

    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('leaves the settings alone after a 4xx refused before writing', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getSettings = vi.spyOn(api, 'getSettings').mockResolvedValue(stored(false));
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new ApiClientError('bad', 'invalid', 400));
    const { result } = renderHook(
      () => ({ query: useSettingsQuery('ws-1'), save: useUpdateSettingsMutation('ws-1') }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(() => result.current.save.mutateAsync(body).catch(() => undefined));

    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting save only after the settings are refetched', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveRefetch: (value: SettingsResponse) => void = () => {};
    vi.spyOn(api, 'getSettings')
      .mockResolvedValueOnce(stored(false))
      .mockImplementationOnce(() => new Promise<SettingsResponse>((resolve) => { resolveRefetch = resolve; }));
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new ApiClientError('changed', 'settings_conflict', 409));

    const { result } = renderHook(
      () => ({ query: useSettingsQuery('ws-1'), save: useUpdateSettingsMutation('ws-1') }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.query.data).toEqual(stored(false)));

    let rejected = false;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.save.mutateAsync(body).catch(() => { rejected = true; });
    });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(2));
    expect(rejected).toBe(false);

    await act(async () => {
      resolveRefetch(stored(true));
      await pending;
    });
    expect(rejected).toBe(true);
    expect(queryClient.getQueryData(settingsKey)).toEqual(stored(true));
  });
});

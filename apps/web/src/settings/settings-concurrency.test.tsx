import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Settings } from '@mergepilot/app/contract';
import * as client from '../api/client.js';
import { useSettingsQuery, useUpdateSettingsMutation } from '../api/hooks.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { usePatchSettings, useWorkspaceSettings } from './useSettingsPatch.js';

const settings: Settings = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en',
  fallback: [], minSeverity: 'medium', monthlyBudgetUsd: 50, runRetentionDays: 30,
};
const initial = { settings, settingsVersion: 'version-1' };
const saved = { settings: { ...settings, runRetentionDays: 90 as const }, settingsVersion: 'version-2' };
const key = ['workspaces', 'ws-1', 'settings'];
const message = 'Settings changed while saving; reload and try again';

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en"><ToastProvider>{children}</ToastProvider></I18nProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('settings versions in dashboard saves', () => {
  it('sends the rendered form version and uses the returned version for the next save', async () => {
    const { queryClient, wrapper } = harness();
    vi.spyOn(client.api, 'getSettings').mockResolvedValue(initial);
    const update = vi.spyOn(client.api, 'updateSettings').mockResolvedValue(saved);
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => {
      const query = useSettingsQuery('ws-1');
      return { query, mutation: useUpdateSettingsMutation('ws-1', query.data?.settingsVersion) };
    }, { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));

    await act(async () => { await result.current.mutation.mutateAsync({ ...settings, runRetentionDays: 90 }); });
    expect(update).toHaveBeenLastCalledWith('ws-1', { ...settings, runRetentionDays: 90, expectedVersion: 'version-1' });
    expect(queryClient.getQueryData(key)).toEqual(saved);
    await waitFor(() => expect(result.current.query.data?.settingsVersion).toBe('version-2'));
    await act(async () => { await result.current.mutation.mutateAsync(saved.settings); });
    expect(update).toHaveBeenLastCalledWith('ws-1', { ...saved.settings, expectedVersion: 'version-2' });
  });

  it('shows a form conflict and refetches the current settings', async () => {
    const { queryClient, wrapper } = harness();
    const get = vi.spyOn(client.api, 'getSettings').mockResolvedValueOnce(initial).mockResolvedValue(saved);
    vi.spyOn(client.api, 'updateSettings').mockRejectedValue(new client.ApiClientError(message, 'settings_conflict', 409));
    const { result } = renderHook(() => {
      const query = useSettingsQuery('ws-1');
      return { query, mutation: useUpdateSettingsMutation('ws-1', query.data?.settingsVersion) };
    }, { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    await act(async () => { await expect(result.current.mutation.mutateAsync(settings)).rejects.toThrow(message); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(queryClient.getQueryData(key)).toEqual(saved);
    expect(screen.getByText(message)).toBeDefined();
  });

  it('sends the patch version and caches the returned settings and version before refetch', async () => {
    const { queryClient, wrapper } = harness();
    const fetch = vi.spyOn(client, 'fetchApi').mockImplementation(async (_path, init) => init?.method === 'PUT' ? saved : initial);
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => ({
      query: useWorkspaceSettings('ws-1'), mutation: usePatchSettings('ws-1', 'retentionSaved'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    await act(async () => { await result.current.mutation.mutateAsync({ runRetentionDays: 90 }); });
    const puts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));
    expect(puts()[0]).toEqual({
      provider: settings.provider, model: settings.model, language: settings.language,
      runRetentionDays: 90, expectedVersion: 'version-1',
    });
    expect(queryClient.getQueryData(key)).toEqual(saved);
    await waitFor(() => expect(result.current.query.data?.settingsVersion).toBe('version-2'));
    await act(async () => { await result.current.mutation.mutateAsync({ runRetentionDays: 180 }); });
    expect(puts()[1]).toMatchObject({ runRetentionDays: 180, expectedVersion: 'version-2' });
  });

  it('rolls back a conflicting patch, shows its message and refetches current settings', async () => {
    const { queryClient, wrapper } = harness();
    let reads = 0;
    const fetch = vi.spyOn(client, 'fetchApi').mockImplementation(async (_path, init) => {
      if (init?.method === 'PUT') throw new client.ApiClientError(message, 'settings_conflict', 409);
      return ++reads === 1 ? initial : saved;
    });
    const { result } = renderHook(() => ({
      query: useWorkspaceSettings('ws-1'), mutation: usePatchSettings('ws-1', 'retentionSaved'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    await act(async () => { await expect(result.current.mutation.mutateAsync({ runRetentionDays: 180 })).rejects.toThrow(message); });
    await waitFor(() => expect(reads).toBe(2));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toHaveProperty('expectedVersion', 'version-1');
    expect(queryClient.getQueryData(key)).toEqual(saved);
    expect(screen.getByText(message)).toBeDefined();
  });
});

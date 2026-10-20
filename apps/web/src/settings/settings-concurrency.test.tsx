import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Settings } from '@mergepilot/app/contract';
import * as client from '../api/client.js';
import { useSettingsQuery, useUpdateSettingsMutation } from '../api/hooks.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { withSettingsBase } from './settings-base.js';
import { settingsPatch, usePatchSettings, useWorkspaceSettings, withRepoColor } from './useSettingsPatch.js';

const settings: Settings = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en',
  fallback: [], minSeverity: 'medium', monthlyBudgetUsd: 50, runRetentionDays: 30, repoColors: {},
};
const initial = { settings };
const saved = { settings: { ...settings, runRetentionDays: 90 as const } };
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

describe('field baselines in dashboard saves', () => {
  it('sends the form baseline supplied in its variables and caches the successful response', async () => {
    const { queryClient, wrapper } = harness();
    vi.spyOn(client.api, 'getSettings').mockResolvedValue(initial);
    const update = vi.spyOn(client.api, 'updateSettings').mockResolvedValue(saved);
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => ({
      query: useSettingsQuery('ws-1'), mutation: useUpdateSettingsMutation('ws-1'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    const body = withSettingsBase({ ...settings, runRetentionDays: 90 }, settings);
    act(() => { queryClient.setQueryData(key, { settings: { ...settings, monthlyBudgetUsd: 75 } }); });
    await act(async () => { await result.current.mutation.mutateAsync(body); });
    expect(update).toHaveBeenLastCalledWith('ws-1', body);
    expect(update.mock.calls[0]?.[1].base).toHaveProperty('monthlyBudgetUsd', 50);
    expect(queryClient.getQueryData(key)).toEqual(saved);
  });

  it('shows a form conflict and refetches current settings', async () => {
    const { queryClient, wrapper } = harness();
    const get = vi.spyOn(client.api, 'getSettings').mockResolvedValueOnce(initial).mockResolvedValue(saved);
    const update = vi.spyOn(client.api, 'updateSettings').mockRejectedValue(new client.ApiClientError(message, 'settings_conflict', 409));
    const { result } = renderHook(() => ({
      query: useSettingsQuery('ws-1'), mutation: useUpdateSettingsMutation('ws-1'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    const body = withSettingsBase(settings, settings);
    await act(async () => { await expect(result.current.mutation.mutateAsync(body)).rejects.toThrow(message); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledWith('ws-1', expect.objectContaining({ base: settings }));
    expect(queryClient.getQueryData(key)).toEqual(saved);
    expect(screen.getByText(message)).toBeDefined();
  });

  it('sends a card baseline and caches the returned settings before refetch', async () => {
    const { queryClient, wrapper } = harness();
    const fetch = vi.spyOn(client, 'fetchApi').mockImplementation(async (_path, init) => init?.method === 'PUT' ? saved : initial);
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => ({
      query: useWorkspaceSettings('ws-1'), mutation: usePatchSettings('ws-1', 'retentionSaved'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    await act(async () => { await result.current.mutation.mutateAsync(settingsPatch(settings, { runRetentionDays: 90 })); });
    const puts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));
    expect(puts()[0]).toEqual({
      provider: settings.provider, model: settings.model, language: settings.language, runRetentionDays: 90,
      base: { provider: settings.provider, model: settings.model, language: settings.language, runRetentionDays: 30 },
    });
    expect(queryClient.getQueryData(key)).toEqual(saved);
    await act(async () => { await result.current.mutation.mutateAsync(settingsPatch(saved.settings, { runRetentionDays: 180 })); });
    expect(puts()[1].base).toHaveProperty('runRetentionDays', 90);
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
    await act(async () => {
      await expect(result.current.mutation.mutateAsync(settingsPatch(settings, { runRetentionDays: 180 }))).rejects.toThrow(message);
    });
    await waitFor(() => expect(reads).toBe(2));
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]?.[1]?.body)).base).toHaveProperty('runRetentionDays', 30);
    expect(queryClient.getQueryData(key)).toEqual(saved);
    expect(screen.getByText(message)).toBeDefined();
  });

  it('rejects a queued color map built before another admin changed that map', async () => {
    const { queryClient, wrapper } = harness();
    let current = structuredClone(settings);
    let release: () => void = () => {};
    const cancel = vi.spyOn(queryClient, 'cancelQueries').mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const fetch = vi.spyOn(client, 'fetchApi').mockImplementation(async (_path, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (JSON.stringify(body.base.repoColors) !== JSON.stringify(current.repoColors)) {
          throw new client.ApiClientError(message, 'settings_conflict', 409);
        }
        current = { ...current, repoColors: body.repoColors };
      }
      return { settings: current };
    });
    const { result } = renderHook(() => ({
      query: useWorkspaceSettings('ws-1'), mutation: usePatchSettings('ws-1', 'repoColorSaved'),
    }), { wrapper });
    await waitFor(() => expect(result.current.query.data).toEqual(initial));
    const body = settingsPatch(settings, { repoColors: withRepoColor(settings.repoColors, 'acme/ours', 'sky') });
    let pending: Promise<unknown> = Promise.resolve();
    act(() => { pending = result.current.mutation.mutateAsync(body).catch((error: unknown) => error); });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    current = { ...settings, repoColors: { 'acme/theirs': 'teal' } };
    act(() => { queryClient.setQueryData(key, { settings: current }); });
    let error: unknown;
    await act(async () => { release(); error = await pending; });
    expect(error).toBeInstanceOf(client.ApiClientError);
    expect((error as client.ApiClientError).status).toBe(409);
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).base.repoColors).toEqual({});
    expect(current.repoColors).toEqual({ 'acme/theirs': 'teal' });
    expect(queryClient.getQueryData(key)).toEqual({ settings: current });
    expect(screen.getByText(message)).toBeDefined();
  });

  it('captures composite values before source objects can be mutated', () => {
    const snapshot = { ...settings, repoColors: { 'acme/one': 'sky' as const } };
    const colors = withRepoColor(snapshot.repoColors, 'acme/two', 'teal');
    const body = settingsPatch(snapshot, { repoColors: colors });
    delete (snapshot.repoColors as Record<string, string>)['acme/one'];
    delete colors['acme/one'];
    expect(body.base?.repoColors).toEqual({ 'acme/one': 'sky' });
    expect(body.repoColors).toEqual({ 'acme/one': 'sky', 'acme/two': 'teal' });
  });
});

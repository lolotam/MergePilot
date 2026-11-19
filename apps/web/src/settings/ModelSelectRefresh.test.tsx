import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { modelsQueryKey } from './providers.js';
import userEvent from '@testing-library/user-event';
import { api, ApiClientError } from '../api/client.js';
import { ModelSelect } from './ModelSelect.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, getModels: vi.fn() } };
});

describe('ModelSelect refresh failure', () => {
  it('keeps the last good catalog in the dropdown when a refresh fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getModels).mockRejectedValue(new ApiClientError('boom', 'server_error', 500));
    vi.mocked(api.getModels).mockResolvedValueOnce({ models: [{ id: 'kept-model', name: 'Kept model', efforts: [] }] });
    renderSettings(<ModelSelect id="m" workspaceId="ws-1" provider="openai" value="" onChange={vi.fn()} />, 'en');
    await user.click(await screen.findByRole('button', { name: 'Model name' }));
    expect(screen.getByRole('option', { name: /Kept model/ })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(() => expect(api.getModels).toHaveBeenCalledWith('ws-1', 'openai', true, expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Model name' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Model name' })).toBeDefined();
    expect((await screen.findByRole('status')).textContent).toMatch(/Could not refresh the model list/);
  });

  it('still reports a failed refresh when the follow-up refetch returns the old list', async () => {
    const user = userEvent.setup();
    const catalog = { models: [{ id: 'kept-model', name: 'Kept model', efforts: [] }] };
    vi.mocked(api.getModels).mockReset();
    vi.mocked(api.getModels).mockResolvedValueOnce(catalog)
      .mockRejectedValueOnce(new ApiClientError('boom', 'server_error', 500)).mockResolvedValue(catalog);
    renderSettings(<ModelSelect id="m" workspaceId="ws-1" provider="openai" value="" onChange={vi.fn()} />, 'en');
    await screen.findByRole('button', { name: 'Model name' });
    await user.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Could not refresh the model list/);
  });

  it('hides the refresh failure once a newer catalog arrives, e.g. from a sync', async () => {
    const user = userEvent.setup();
    const catalog = { models: [{ id: 'kept-model', name: 'Kept model', efforts: [] }] };
    vi.mocked(api.getModels).mockReset();
    vi.mocked(api.getModels).mockResolvedValueOnce(catalog)
      .mockRejectedValueOnce(new ApiClientError('boom', 'server_error', 500)).mockResolvedValue(catalog);
    function SyncResult() {
      const client = useQueryClient();
      return <button onClick={() => client.setQueryData(modelsQueryKey('ws-1', 'openai'), { models: [] })}>Synced</button>;
    }
    renderSettings(<><SyncResult /><ModelSelect id="m" workspaceId="ws-1" provider="openai" value="" onChange={vi.fn()} /></>, 'en');
    await screen.findByRole('button', { name: 'Model name' });
    await user.click(screen.getByRole('button', { name: 'Refresh list' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Synced' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

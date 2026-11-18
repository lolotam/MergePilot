import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
});

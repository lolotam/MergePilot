import { act, screen, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { api, type ModelsResponse } from '../api/client.js';
import { refreshCredentialQueries } from '../api/credential-queries.js';
import { SyncModels } from './SyncModels.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, syncModels: vi.fn() } };
});

it('aborts changed providers, skips changed queued work, and preserves unrelated results', async () => {
  let finishOpenAi!: (value: ModelsResponse) => void;
  let finishAnthropic!: (value: ModelsResponse) => void;
  const openai = new Promise<ModelsResponse>((resolve) => { finishOpenAi = resolve; });
  const anthropic = new Promise<ModelsResponse>((resolve) => { finishAnthropic = resolve; });
  const live: ModelsResponse = { source: 'live', models: [] };
  vi.mocked(api.syncModels)
    .mockReturnValueOnce(openai)
    .mockReturnValueOnce(anthropic)
    .mockResolvedValueOnce(live);
  function RotateCredentials() {
    const client = useQueryClient();
    return <button onClick={() => void refreshCredentialQueries(client, 'ws-1', ['openai', 'gemini'])}>Rotate credentials</button>;
  }
  const user = userEvent.setup();
  renderSettings(<>
    <RotateCredentials />
    <SyncModels workspaceId="ws-1" providers={['openai', 'anthropic', 'gemini', 'xai']} />
  </>, 'en');
  await user.click(screen.getByRole('button', { name: 'Sync all models' }));
  expect(vi.mocked(api.syncModels).mock.calls.map(([, provider]) => provider)).toEqual(['openai', 'anthropic']);
  await user.click(screen.getByRole('button', { name: 'Rotate credentials' }));
  expect(vi.mocked(api.syncModels).mock.calls.map(([, , signal]) => signal.aborted)).toEqual([true, false]);
  await act(async () => finishAnthropic(live));
  await waitFor(() => expect(vi.mocked(api.syncModels).mock.calls.map(([, provider]) => provider))
    .toEqual(['openai', 'anthropic', 'xai']));
  await act(async () => finishOpenAi(live));
  expect(screen.getAllByText(/Credentials changed/)).toHaveLength(2);
  expect(screen.getAllByText(/Last live sync/)).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Rotate credentials' }));
  expect(screen.getAllByText(/Last live sync/)).toHaveLength(2);
});

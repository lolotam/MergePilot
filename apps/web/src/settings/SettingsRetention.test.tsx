import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Settings } from '@mergepilot/app/contract';
import * as client from '../api/client.js';
import * as hooks from '../api/hooks.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { baseSettings, fakeSettingsServer } from '../runs/runs-test-utils.js';
import { RepoColorsCard } from './RepoColorsCard.js';
import { RetentionCard } from './RetentionCard.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));

function renderCards(isMember: boolean, settings: Partial<Settings> | null) {
  vi.mocked(hooks.useRunReposQuery).mockReturnValue({
    data: { repos: ['acme/web', 'acme/backend'] },
  } as unknown as ReturnType<typeof hooks.useRunReposQuery>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], {
    settings: settings === null ? null : { ...baseSettings, ...settings },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <ToastProvider>
          <RetentionCard workspaceId="ws-1" isMember={isMember} />
          <RepoColorsCard workspaceId="ws-1" isMember={isMember} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const putBodies = () =>
  vi
    .mocked(client.fetchApi)
    .mock.calls.filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

describe('Settings: review history retention and repository colors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the retention choice (forever = null) without touching other fields', async () => {
    fakeSettingsServer(client.fetchApi);
    renderCards(false, {});
    const select = screen.getByLabelText('Keep review history for') as HTMLSelectElement;
    expect(select.value).toBe('30');
    expect(screen.getByText(/Comments on GitHub are not affected/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'forever' } });
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en', runRetentionDays: null });
    await waitFor(() => expect(select.value).toBe('forever'));

    fireEvent.change(select, { target: { value: '365' } });
    await waitFor(() => expect(putBodies()[1]).toMatchObject({ runRetentionDays: 365 }));
  });

  it('picks a repo color, recolors the chip, and "Auto" removes the choice', async () => {
    const saved = fakeSettingsServer(client.fetchApi);
    renderCards(false, {});
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('[data-repo-color]')?.textContent)).toEqual(['acme/backend', 'acme/web']);

    const web = rows[1]!;
    fireEvent.click(within(web).getByRole('button', { name: 'Violet' }));
    await waitFor(() => expect(web.querySelector('[data-repo-color]')?.getAttribute('data-repo-color')).toBe('violet'));
    await waitFor(() => expect(saved().repoColors).toEqual({ 'acme/web': 'violet' }));
    expect(within(web).getByRole('button', { name: 'Violet' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(web).getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(saved().repoColors).toEqual({}));
    expect(web.querySelector('[data-repo-color]')?.getAttribute('data-repo-color')).toBe('amber');
  });

  it('is read-only for members', () => {
    renderCards(true, {});
    expect((screen.getByLabelText('Keep review history for') as HTMLSelectElement).disabled).toBe(true);
    for (const b of screen.getAllByRole('button', { name: 'Violet' })) expect(b.hasAttribute('disabled')).toBe(true);
  });

  it('asks to save the review settings first when there are none', () => {
    renderCards(false, null);
    expect(screen.getAllByText('Save the review settings above first.').length).toBeGreaterThanOrEqual(1);
    expect((screen.getByLabelText('Keep review history for') as HTMLSelectElement).disabled).toBe(true);
  });
});

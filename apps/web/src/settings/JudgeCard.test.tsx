import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JudgeSettings, Settings } from '@mergepilot/app/contract';
import * as client from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { baseSettings } from '../runs/runs-test-utils.js';
import type { KeyProvider } from '../api/client.js';
import { JudgeCard } from './JudgeCard.js';

vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));

const catalog: client.JudgeProvidersResponse = {
  providers: [
    { id: 'typesafe', label: 'TypeSafe', models: ['jev-latest'], keyOnly: true },
    { id: 'openrouter', label: 'OpenRouter', models: ['~typesafe/jev-latest', 'typesafe/jev-1.13'], keyOnly: false },
    { id: 'vercel-gateway', label: 'Vercel AI Gateway', models: ['typesafe-ai/jev'], keyOnly: false },
    { id: 'opencode-zen', label: 'OpenCode Zen', models: ['jev-1.13-free', 'jev-1.13'], keyOnly: false },
  ],
};

const stored: JudgeSettings = { enabled: true, provider: 'typesafe', model: 'jev-latest', mode: 'filter', threshold: 0.35, fallback: [] };

function renderCard(options: { isMember?: boolean; keyed?: KeyProvider[]; judge?: JudgeSettings | null } = {}) {
  vi.spyOn(client.api, 'getJudgeProviders').mockResolvedValue(catalog);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const settings: Settings = { ...baseSettings, judge: options.judge === undefined ? stored : options.judge };
  queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], { settings });
  vi.mocked(client.fetchApi).mockImplementation(async (_path: string, init?: RequestInit) => ({
    settings: init?.body ? { ...settings, ...(JSON.parse(String(init.body)) as object) } : settings,
  }));
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <ToastProvider>
          <JudgeCard workspaceId="ws-1" isMember={options.isMember ?? false} keyedProviders={options.isMember ? undefined : (options.keyed ?? ['typesafe', 'openrouter'])} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const optionValues = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
const putBodies = () =>
  vi
    .mocked(client.fetchApi)
    .mock.calls.filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

describe('JudgeCard (Jev)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers only Jev models for the chosen provider, and only providers with a key plus the Jev-only types', async () => {
    renderCard({ keyed: ['typesafe', 'opencode-zen'] });
    const provider = await screen.findByLabelText('Judge provider', { selector: '#judge-provider' });
    expect(optionValues(provider)).toEqual(['typesafe', 'opencode-zen']);
    expect(optionValues(screen.getByLabelText('Jev model', { selector: '#judge-model' }))).toEqual(['jev-latest']);

    fireEvent.change(provider, { target: { value: 'opencode-zen' } });
    const model = screen.getByLabelText('Jev model', { selector: '#judge-model' }) as HTMLSelectElement;
    expect(optionValues(model)).toEqual(['jev-1.13-free', 'jev-1.13']);
    expect(model.value).toBe('jev-1.13-free');
  });

  it('shows only Jev for a stored Vercel AI Gateway key, though that key also serves review models', async () => {
    renderCard({ keyed: ['typesafe', 'vercel-gateway'] });
    const provider = await screen.findByLabelText('Judge provider', { selector: '#judge-provider' });
    expect(optionValues(provider)).toEqual(['typesafe', 'vercel-gateway']);
    fireEvent.change(provider, { target: { value: 'vercel-gateway' } });
    const model = screen.getByLabelText('Jev model', { selector: '#judge-model' }) as HTMLSelectElement;
    expect(optionValues(model)).toEqual(['typesafe-ai/jev']);
    expect(model.value).toBe('typesafe-ai/jev');
  });

  it('adds up to three fallback rows, removes one, and saves the judge', async () => {
    renderCard();
    const add = await screen.findByRole('button', { name: 'Add fallback' });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback' }));
    expect(screen.getAllByText(/^Fallback \d$/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Add fallback' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Judge provider', { selector: '#judge-fallback-1-provider' }), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove fallback 1' }));
    expect(screen.getAllByText(/^Fallback \d$/)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Save judge settings' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.judge).toEqual({
      ...stored,
      fallback: [
        { provider: 'openrouter', model: '~typesafe/jev-latest' },
        { provider: 'typesafe', model: 'jev-latest' },
      ],
    });
  });

  it('tests the judge and shows ok · model · ms', async () => {
    const testJudge = vi.spyOn(client.api, 'testJudge').mockResolvedValue({ ok: true, ms: 42, model: 'jev-latest' });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Test (typesafe)' }));
    expect(await screen.findByText('ok · jev-latest · 42ms')).toBeDefined();
    expect(testJudge).toHaveBeenCalledWith('ws-1', { provider: 'typesafe', model: 'jev-latest' });
  });

  it('starts off for a workspace without a judge, and is read-only for members', async () => {
    renderCard({ isMember: true, judge: null });
    const enabled = (await screen.findByLabelText('Enable the Jev judge')) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect(enabled.disabled).toBe(true);
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('off');
    expect((screen.getByRole('button', { name: 'Add fallback' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^Test/ })).toBeNull();
  });
});

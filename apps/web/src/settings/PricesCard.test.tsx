import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PricesResponse, Settings } from '@mergepilot/app/contract';
import * as client from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { baseSettings } from '../runs/runs-test-utils.js';
import { PricesCard } from './PricesCard.js';

vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));

const FETCHED = '2026-10-13T02:30:00.000Z';
const PRICES_LOAD_ERROR = 'Could not load the model prices.';

const prices: PricesResponse = {
  models: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      role: 'primary',
      price: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
      source: 'catalog:models.dev',
      fetchedAt: FETCHED,
      overridden: false,
    },
    {
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      role: 'heavy',
      price: { inputPerMTok: 0.6, outputPerMTok: 2.2 },
      source: 'catalog:openrouter',
      fetchedAt: FETCHED,
      overridden: false,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      role: 'fallback',
      price: { inputPerMTok: 1, outputPerMTok: 2 },
      source: 'override',
      fetchedAt: null,
      overridden: true,
    },
    { provider: 'xai', model: 'grok-x', role: 'fallback', price: null, source: 'unknown', fetchedAt: null, overridden: false },
    {
      provider: 'typesafe',
      model: 'jev-latest',
      role: 'judge',
      price: { inputPerMTok: 0.042, outputPerMTok: 0 },
      source: 'static',
      fetchedAt: null,
      overridden: false,
    },
    {
      provider: 'vercel-gateway',
      model: 'typesafe-ai/jev',
      role: 'judge-fallback',
      price: { inputPerMTok: 0.05, outputPerMTok: 0 },
      source: 'catalog:vercel',
      fetchedAt: FETCHED,
      overridden: false,
    },
  ],
  sources: [
    { source: 'openrouter', fetchedAt: FETCHED },
    { source: 'vercel', fetchedAt: FETCHED },
    { source: 'models.dev', fetchedAt: null },
  ],
};

const deepseekOverride = { provider: 'deepseek', model: 'deepseek-chat', inputPerMTok: 1, outputPerMTok: 2 };
const unusedOverride = { provider: 'openai', model: 'gpt-5', inputPerMTok: 5, outputPerMTok: 10 };

function renderCard(options: { isMember?: boolean; putError?: Error; pricesData?: PricesResponse; settingsError?: Error } = {}) {
  const settings: Settings = { ...baseSettings, priceOverrides: [deepseekOverride, unusedOverride] };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!options.settingsError) queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], { settings });
  vi.mocked(client.fetchApi).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/prices')) return options.pricesData ?? prices;
    if (options.settingsError && !init?.method) throw options.settingsError;
    if (init?.method === 'PUT') {
      if (options.putError) throw options.putError;
      const { base: _base, ...patch } = JSON.parse(String(init.body));
      return { settings: { ...settings, ...patch } };
    }
    return { settings };
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <ToastProvider>
          <PricesCard workspaceId="ws-1" isMember={options.isMember ?? false} />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const putBodies = () =>
  vi
    .mocked(client.fetchApi)
    .mock.calls.filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

/** The table row of one model (found by its model id). */
async function rowOf(model: string): Promise<HTMLElement> {
  const cell = await screen.findByText(model);
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${model}`);
  return row;
}

describe('PricesCard (model prices)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes a stale price draft on a settings conflict and shows the server message', async () => {
    const message = 'Settings changed while saving; reload and try again';
    renderCard({ putError: new client.ApiClientError(message, 'settings_conflict', 409) });
    const main = await rowOf('claude-sonnet-5-5');
    fireEvent.click(within(main).getByRole('button', { name: 'Edit price' }));
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    expect(screen.getByText(message)).toBeDefined();
  });

  it('bases a price save on the exact current list, even after a refetch and a pencil re-click', async () => {
    const { queryClient } = renderCard();
    fireEvent.click(within(await rowOf('claude-sonnet-5-5')).getByRole('button', { name: 'Edit price' }));
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '8' } });
    const latest = [deepseekOverride, { ...unusedOverride, inputPerMTok: 99 }];
    act(() => {
      queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], {
        settings: { ...baseSettings, priceOverrides: latest },
      });
    });
    fireEvent.click(within(await rowOf('claude-sonnet-5-5')).getByRole('button', { name: 'Edit price' }));
    expect((screen.getByLabelText('Input $/1M') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.base).toHaveProperty('priceOverrides', latest);
    expect(putBodies()[0]?.priceOverrides).toMatchObject([...latest, {
      provider: 'anthropic', model: 'claude-sonnet-5-5', inputPerMTok: 2, outputPerMTok: 8,
    }]);
  });

  it('opens one editor when the same model is listed twice (main and heavy)', async () => {
    const twice: PricesResponse = { ...prices, models: [prices.models[0]!, { ...prices.models[0]!, role: 'heavy' }] };
    renderCard({ pricesData: twice });
    const edits = await screen.findAllByRole('button', { name: 'Edit price' });
    expect(edits).toHaveLength(2);
    fireEvent.click(edits[1]!);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1));
  });

  it('reports a failed settings load instead of loading forever', async () => {
    renderCard({ settingsError: new Error('boom') });
    expect(await screen.findByText(PRICES_LOAD_ERROR)).toBeTruthy();
  });

  it('lists every model with its role, prices, source badge and fetch time; Unknown shows dashes', async () => {
    renderCard();
    expect(screen.getByText('Model prices')).toBeTruthy();

    const main = await rowOf('claude-sonnet-5-5');
    expect(within(main).getByText('Main')).toBeTruthy();
    expect(within(main).getByText('anthropic')).toBeTruthy();
    expect(within(main).getByText('$3.00')).toBeTruthy();
    expect(within(main).getByText('$15.00')).toBeTruthy();
    expect(within(main).getByText('$3.00').getAttribute('title')).toContain('$0.30');
    expect(within(main).getByText('models.dev')).toBeTruthy();
    const fetched = within(main).getByTestId('price-fetched-at');
    expect(fetched.getAttribute('title')).toMatch(/Oct 13, 2026/);

    expect(within(await rowOf('z-ai/glm-5')).getByText('Heavy')).toBeTruthy();
    expect(within(await rowOf('z-ai/glm-5')).getByText('OpenRouter')).toBeTruthy();
    expect(within(await rowOf('deepseek-chat')).getByText('Fallback 1')).toBeTruthy();
    expect(within(await rowOf('deepseek-chat')).getByText('Manual')).toBeTruthy();

    const unknown = await rowOf('grok-x');
    expect(within(unknown).getByText('Fallback 2')).toBeTruthy();
    const badge = within(unknown).getByText('Unknown');
    expect(badge.className).toContain('amber');
    expect(within(unknown).getAllByText('—').length).toBeGreaterThanOrEqual(2);

    const judge = await rowOf('jev-latest');
    expect(within(judge).getByText('Jev')).toBeTruthy();
    expect(within(judge).getByText('Built-in')).toBeTruthy();
    expect(within(judge).getByText('$0.042')).toBeTruthy();
    const judgeFallback = await rowOf('typesafe-ai/jev');
    expect(within(judgeFallback).getByText('Jev fallback 1')).toBeTruthy();
    expect(within(judgeFallback).getByText('Vercel')).toBeTruthy();

    const refreshed = screen.getByTestId('price-sources');
    expect(refreshed.textContent).toContain('models.dev: never');
    expect(screen.getByText(/refreshed daily/)).toBeTruthy();
  });

  it('an admin sets a price for an unknown model: the PUT holds the whole list with the new entry', async () => {
    renderCard();
    fireEvent.click(within(await rowOf('grok-x')).getByRole('button', { name: 'Edit price' }));
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Cache read $/1M (optional)'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      base: {
        provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en', priceOverrides: [deepseekOverride, unusedOverride],
      },
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      language: 'en',
      priceOverrides: [
        deepseekOverride,
        unusedOverride,
        { provider: 'xai', model: 'grok-x', inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 },
      ],
    });
    await waitFor(() => expect(screen.queryByLabelText('Input $/1M')).toBeNull());
  });

  it('editing an overridden model replaces its entry in place, prefilled with its price', async () => {
    renderCard();
    fireEvent.click(within(await rowOf('deepseek-chat')).getByRole('button', { name: 'Edit price' }));
    const input = screen.getByLabelText('Input $/1M') as HTMLInputElement;
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!['priceOverrides']).toEqual([{ ...deepseekOverride, inputPerMTok: 1.5 }, unusedOverride]);
  });

  it('"Use automatic price" removes only that override', async () => {
    renderCard();
    const row = await rowOf('deepseek-chat');
    expect(within(await rowOf('grok-x')).queryByRole('button', { name: 'Use automatic price' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Use automatic price' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]!['priceOverrides']).toEqual([unusedOverride]);
  });

  it('checks the 0–1000 range before saving, and shows the server message on error', async () => {
    renderCard({ putError: new client.ApiClientError('priceOverrides: at most 50 entries', 'invalid_settings', 400) });
    fireEvent.click(within(await rowOf('grok-x')).getByRole('button', { name: 'Edit price' }));
    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '1001' } });
    fireEvent.change(screen.getByLabelText('Output $/1M'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByTestId('price-edit-error')).textContent).toMatch(/0 to 1000/);
    expect(putBodies()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Input $/1M'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('price-edit-error').textContent).toBe('priceOverrides: at most 50 entries'));
    expect(screen.getByLabelText('Input $/1M')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Input $/1M')).toBeNull();
  });

  it('is read-only for members: prices show, no edit buttons', async () => {
    renderCard({ isMember: true });
    await rowOf('grok-x');
    expect(screen.queryByRole('button', { name: 'Edit price' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use automatic price' })).toBeNull();
    expect(screen.getAllByText('$3.00').length).toBe(1);
  });
});

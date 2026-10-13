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

const stored: JudgeSettings = { enabled: true, provider: 'typesafe', model: 'jev-latest', uses: ['filter', 'dedupe'], threshold: 0.35, fallback: [] };

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

  it('saves any combination of uses as one multi-select payload', async () => {
    renderCard();
    const annotate = (await screen.findByRole('checkbox', { name: /^Annotate/ })) as HTMLInputElement;
    expect(annotate.checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /^Filter/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(annotate);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Consensus/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Duplicate check/ }));
    expect(screen.getByText('In consensus mode, the review panel uses it to tell whether two bots found the same issue, so it is posted once.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Save judge settings' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.judge).toEqual({ ...stored, uses: ['annotate', 'filter', 'consensus'] });
    expect(putBodies()[0]?.judge).not.toHaveProperty('mode');
  });

  it('enables the threshold only while Filter is ticked', async () => {
    renderCard();
    const threshold = (await screen.findByLabelText('Threshold')) as HTMLInputElement;
    expect(threshold.disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Filter/ }));
    expect(threshold.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Filter/ }));
    expect(threshold.disabled).toBe(false);
  });

  it('pre-selects Annotate + Duplicate check when Enable is switched on with no uses', async () => {
    renderCard({ judge: { ...stored, enabled: false, uses: [] } });
    fireEvent.click(await screen.findByLabelText('Enable the Jev judge'));
    expect((screen.getByRole('checkbox', { name: /^Annotate/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /^Duplicate check/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /^Filter/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Threshold') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(/has nothing to do/)).toBeNull();
  });

  it('warns when the judge is enabled with no uses (idle), and the owner may still untick them all', async () => {
    renderCard({ judge: { ...stored, uses: ['dedupe'] } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Duplicate check/ }));
    expect(screen.getByText('Jev is enabled but has nothing to do: pick at least one use.').getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('button', { name: 'Save judge settings' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.judge).toMatchObject({ enabled: true, uses: [] });
  });

  it('marks a fallback whose provider has no stored key', async () => {
    renderCard({ judge: { ...stored, fallback: [{ provider: 'opencode-zen', model: 'jev-1.13-free' }, { provider: 'openrouter', model: 'typesafe/jev-1.13' }] } });
    const first = (await screen.findByText('Fallback 1')).closest('li') as HTMLElement;
    const second = screen.getByText('Fallback 2').closest('li') as HTMLElement;
    expect(within(first).getByText('no key')).toBeDefined();
    expect(within(second).queryByText('no key')).toBeNull();
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
    for (const name of [/^Annotate/, /^Filter/, /^Duplicate check/, /^Consensus/]) {
      const box = screen.getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(true);
    }
    expect((screen.getByRole('button', { name: 'Add fallback' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^Test/ })).toBeNull();
  });
});

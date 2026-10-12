import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FallbackEntry } from '@mergepilot/app/contract';
import { api, ApiClientError, type ApiProvider } from '../api/client.js';
import { EffortSelect } from './EffortSelect.js';
import { FallbackModelsCard } from './FallbackModelsCard.js';
import { HeavyModelCard } from './HeavyModelCard.js';
import { ModelSelect } from './ModelSelect.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { SeveritySelect } from './SeveritySelect.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, getModels: vi.fn(), testConnection: vi.fn(), testModelsUnsaved: vi.fn() } };
});

const CATALOG = {
  models: [
    { id: 'openai/gpt-5:free', name: 'GPT-5 (free)', efforts: ['low', 'medium', 'high'] },
    { id: 'z-ai/glm-5', name: 'GLM 5', efforts: ['on', 'off'] },
    { id: 'plain', name: 'Plain', efforts: [] },
  ],
};

describe('J2 settings components', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue(CATALOG);
  });

  it('ModelSelect fills the dropdown from the models endpoint and reports the picked model with its efforts', async () => {
    const onChange = vi.fn();
    renderSettings(<ModelSelect id="m" workspaceId="ws-1" provider="openrouter" value="" onChange={onChange} />, 'en');
    await user.click(await screen.findByRole('button', { name: 'Model name' }));
    await user.type(screen.getByRole('searchbox'), 'glm');
    expect(screen.queryByText('GPT-5 (free)')).toBeNull();
    await user.click(screen.getByRole('option', { name: /GLM 5/ }));
    expect(onChange).toHaveBeenCalledWith('z-ai/glm-5', ['on', 'off']);
    expect(api.getModels).toHaveBeenCalledWith('ws-1', 'openrouter');
  });

  it('ModelSelect falls back to free text with an "add a key" hint when the provider has no key', async () => {
    vi.mocked(api.getModels).mockRejectedValue(new ApiClientError('no key', 'key_not_found', 404));
    const onChange = vi.fn();
    renderSettings(<ModelSelect id="m" workspaceId="ws-1" provider="zai-coding" value="" onChange={onChange} />, 'en');
    expect(await screen.findByText(/Add an API key for this provider first/)).toBeDefined();
    await user.type(screen.getByRole('textbox', { name: 'Model name' }), 'g');
    expect(onChange).toHaveBeenLastCalledWith('g', []);
  });

  it('ModelSelect refresh asks the server to bypass its cache', async () => {
    renderSettings(<ModelSelect id="m" workspaceId="ws-1" provider="openai" value="" onChange={vi.fn()} />, 'en');
    await screen.findByRole('button', { name: 'Model name' });
    await user.click(screen.getByRole('button', { name: 'Refresh list' }));
    await waitFor(() => expect(api.getModels).toHaveBeenCalledWith('ws-1', 'openai', true));
  });

  it('EffortSelect lists the model efforts, is labelled, and hides when there are none', async () => {
    const onChange = vi.fn();
    const { container, rerender } = renderSettings(
      <EffortSelect id="e" efforts={['off', 'low', 'high']} value="low" onChange={onChange} />,
      'en',
    );
    const select = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement;
    expect(select.value).toBe('low');
    await user.selectOptions(select, 'high');
    expect(onChange).toHaveBeenCalledWith('high');
    rerender(<EffortSelect id="e" efforts={[]} value={null} onChange={onChange} />);
    expect(container.querySelector('select')).toBeNull();
  });

  it('SeveritySelect changes the minimum severity', async () => {
    const onChange = vi.fn();
    renderSettings(<SeveritySelect value="medium" onChange={onChange} />);
    await user.selectOptions(screen.getByRole('combobox'), 'critical');
    expect(onChange).toHaveBeenCalledWith('critical');
  });

  it('HeavyModelCard stays open while a model is chosen and offers only keyed providers', async () => {
    const onChange = vi.fn();
    const value = { heavyProvider: null, heavyModel: null, heavyEffort: null, heavyThresholdLines: null };
    const { rerender } = renderSettings(
      <HeavyModelCard workspaceId="ws-1" value={value} onChange={onChange} providers={['openrouter']} defaultProvider="openrouter" />,
      'en',
    );
    await user.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith({ heavyProvider: 'openrouter', heavyModel: null, heavyEffort: null, heavyThresholdLines: 800 });

    const on = { heavyProvider: 'openrouter' as ApiProvider, heavyModel: null, heavyEffort: null, heavyThresholdLines: 800 };
    rerender(<HeavyModelCard workspaceId="ws-1" value={on} onChange={onChange} providers={['openrouter']} defaultProvider="openrouter" />);
    const providerSelect = screen.getByRole('combobox', { name: 'Heavy model provider' });
    expect(within(providerSelect).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['openrouter']);
    await user.click(await screen.findByRole('button', { name: 'Heavy model' }));
    await user.click(screen.getByRole('option', { name: /GPT-5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...on, heavyModel: 'openai/gpt-5:free', heavyEffort: null });
    expect(screen.getByRole('spinbutton', { name: 'Changed lines threshold' })).toBeDefined();
  });

  it('FallbackModelsCard adds (max 3), reorders and removes entries', async () => {
    let current: FallbackEntry[] = [
      { provider: 'openrouter', model: 'a', effort: null },
      { provider: 'openrouter', model: 'b', effort: null },
    ];
    const onChange = vi.fn((next: FallbackEntry[]) => {
      current = next;
    });
    const view = (list: FallbackEntry[]) => (
      <FallbackModelsCard workspaceId="ws-1" fallbacks={list} onChange={onChange} providers={['openrouter', 'zai-coding']} />
    );
    const { rerender } = renderSettings(view(current), 'en');
    await user.click(screen.getByRole('button', { name: /Add fallback model/ }));
    expect(current[2]).toEqual({ provider: 'openrouter', model: '', effort: null });
    rerender(view(current));
    expect((screen.getByRole('button', { name: /Add fallback model/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getAllByRole('button', { name: 'Move up' })[1]!);
    expect(current.map((f) => f.model)).toEqual(['b', 'a', '']);
    rerender(view(current));
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[2]!);
    expect(current.map((f) => f.model)).toEqual(['b', 'a']);
  });

  it('ReviewSettingsCard: effort follows the model and the full payload is saved', async () => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'ar', effort: 'on', fallback: [], minSeverity: 'medium' }}
        isLoading={false}
        isMember={false}
        onSave={onSave}
        isSaving={false}
        keyedProviders={['openrouter']}
      />,
      'en',
    );
    const effort = (await screen.findByRole('combobox', { name: 'Effort' })) as HTMLSelectElement;
    expect([...effort.options].map((o) => o.value)).toEqual(['', 'on', 'off']);

    await user.click(screen.getByRole('button', { name: 'Model name' }));
    await user.click(screen.getByRole('option', { name: /GPT-5/ }));
    const updated = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement;
    expect([...updated.options].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high']);
    expect(updated.value).toBe('');
    await user.selectOptions(updated, 'high');
    await user.selectOptions(screen.getByRole('combobox', { name: /Minimum severity/ }), 'high');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openrouter', model: 'openai/gpt-5:free', effort: 'high', minSeverity: 'high', fallback: [] }),
    );
  });

  it('ReviewSettingsCard refuses to save an enabled heavy model without a model', async () => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ provider: 'openrouter', model: 'plain', language: 'en', fallback: [], minSeverity: 'medium' }}
        isLoading={false}
        isMember={false}
        onSave={onSave}
        isSaving={false}
        keyedProviders={['openrouter']}
      />,
      'en',
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Choose the heavy-duty model/)).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  });
});

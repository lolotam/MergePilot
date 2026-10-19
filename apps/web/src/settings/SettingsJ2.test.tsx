import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FallbackEntry } from '@mergepilot/app/contract';
import { api, ApiClientError, type ApiProvider } from '../api/client.js';
import { EffortSelect } from './EffortSelect.js';
import { FallbackModelsCard } from './FallbackModelsCard.js';
import { HeavyModelCard } from './HeavyModelCard.js';
import { MaxFindingsSelect } from './MaxFindingsSelect.js';
import { ModelSelect } from './ModelSelect.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { SeveritySelect } from './SeveritySelect.js';
import { arSettings } from '../i18n/settings-ar.js';
import { enSettings } from '../i18n/settings-en.js';
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

  it('MaxFindingsSelect offers 5 to 50 in steps of 5 and reports the number picked', async () => {
    const onChange = vi.fn();
    renderSettings(<MaxFindingsSelect value={5} onChange={onChange} />, 'en');
    const select = screen.getByRole('combobox', { name: 'Maximum review comments per PR review' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['5', '10', '15', '20', '25', '30', '35', '40', '45', '50']);
    expect(select.value).toBe('5');
    await user.selectOptions(select, '35');
    expect(onChange).toHaveBeenCalledWith(35);
  });

  it('ReviewSettingsCard shows the stored findings limit and saves the one picked', async () => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'ar', fallback: [], minSeverity: 'medium', maxFindings: 20 }}
        isLoading={false}
        isMember={false}
        onSave={onSave}
        isSaving={false}
        keyedProviders={['openrouter']}
      />,
      'en',
    );
    const select = screen.getByRole('combobox', { name: /Maximum review comments/ }) as HTMLSelectElement;
    expect(select.value).toBe('20');
    await user.selectOptions(select, '50');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ maxFindings: 50 }));
  });

  it('ReviewSettingsCard starts the findings limit at 5 and disables it for members', async () => {
    renderSettings(
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'ar', fallback: [], minSeverity: 'medium' }}
        isLoading={false}
        isMember
        onSave={vi.fn(async () => undefined)}
        isSaving={false}
      />,
      'en',
    );
    const select = screen.getByRole('combobox', { name: /Maximum review comments/ }) as HTMLSelectElement;
    expect(select.value).toBe('5');
    expect(select.disabled).toBe(true);
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
  it.each(['en', 'ar'] as const)('shows and saves the per-review cap with its localized hint (%s)', async (language) => {
    const onSave = vi.fn(async () => undefined);
    const strings = language === 'ar' ? arSettings : enSettings;
    renderSettings(<ReviewSettingsCard workspaceId="ws-1"
      settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'ar', fallback: [], minSeverity: 'medium', perReviewUsd: 3 }}
      isLoading={false} isMember={false} onSave={onSave} isSaving={false} />, language);
    const input = screen.getByRole('spinbutton', { name: strings.perReviewLabel }) as HTMLInputElement;
    expect(input.value).toBe('3');
    expect(input.min).toBe('0.5');
    expect(input.max).toBe('1000');
    expect(input.step).toBe('0.5');
    expect(screen.getByText(strings.perReviewHint)).toBeTruthy();
    await user.clear(input);
    await user.type(input, '3.21');
    await user.click(input.closest('form')!.querySelector('button[type=submit]')!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ perReviewUsd: 3.21 }));
  });

  it.each(['', '0.49', '1000.01', '1.001'])('refuses invalid spending caps (%s)', async (value) => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(<ReviewSettingsCard workspaceId="ws-1"
      settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'en', fallback: [], minSeverity: 'medium' }}
      isLoading={false} isMember={false} onSave={onSave} isSaving={false} />, 'en');
    const input = screen.getByRole('spinbutton', { name: enSettings.perReviewLabel }) as HTMLInputElement;
    expect(input.value).toBe('0.5');
    await user.clear(input);
    if (value) await user.type(input, value);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText(enSettings.perReviewInvalid)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('checks the monthly relation when either field changes and accepts equality', async () => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(<ReviewSettingsCard workspaceId="ws-1"
      settings={{ provider: 'openrouter', model: 'z-ai/glm-5', language: 'en', fallback: [], minSeverity: 'medium', perReviewUsd: 3, monthlyBudgetUsd: 10 }}
      isLoading={false} isMember={false} onSave={onSave} isSaving={false} />, 'en');
    const perReview = screen.getByRole('spinbutton', { name: enSettings.perReviewLabel });
    const monthly = document.getElementById('settings-budget')!;
    const save = screen.getByRole('button', { name: 'Save settings' });
    await user.clear(monthly);
    await user.type(monthly, '2');
    await user.click(save);
    expect(screen.getByText(enSettings.perReviewAboveMonthly)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    await user.clear(perReview);
    await user.type(perReview, '2');
    await user.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ perReviewUsd: 2, monthlyBudgetUsd: 2 }));
    onSave.mockClear();
    await user.clear(perReview);
    await user.type(perReview, '3');
    await user.click(save);
    expect(screen.getByText(enSettings.perReviewAboveMonthly)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables the per-review cap for members', () => {
    renderSettings(<ReviewSettingsCard workspaceId="ws-1" settings={null}
      isLoading={false} isMember onSave={vi.fn()} isSaving={false} />, 'en');
    expect((screen.getByRole('spinbutton', { name: enSettings.perReviewLabel }) as HTMLInputElement).disabled).toBe(true);
  });

});

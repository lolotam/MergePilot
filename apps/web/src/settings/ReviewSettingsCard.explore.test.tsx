import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';
import { ApiClientError, api } from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { renderSettings } from './settings.fixtures.js';
import { MAIN_SETTINGS } from './bots/bots-test-utils.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn() } };
});

const SAVED: Settings = { ...MAIN_SETTINGS, exploreEnabled: false, monthlyBudgetUsd: 50 };

/** The main bot's card with the given settings and save. */
const card = (settings: Settings, onSave: (next: SettingsUpdate) => Promise<void>) => (
  <ToastProvider>
    <ReviewSettingsCard
      workspaceId="ws-1"
      settings={settings}
      isLoading={false}
      isMember={false}
      onSave={onSave}
      isSaving={false}
      keyedProviders={['openrouter']}
    />
  </ToastProvider>
);

const exploreSwitch = () => screen.getByRole('switch', { name: 'Explore the repository' }) as HTMLButtonElement;
const botNameField = () => screen.getByRole('textbox', { name: 'Bot name' }) as HTMLInputElement;

describe('ReviewSettingsCard exploration switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue({ models: [] });
  });

  it('sends only the switch change and keeps the unsaved form edits', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    const { rerender } = renderSettings(card(SAVED, onSave), 'en');
    await user.clear(botNameField());
    await user.type(botNameField(), 'Draft name');

    await user.click(exploreSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      provider: SAVED.provider,
      model: SAVED.model,
      language: SAVED.language,
      exploreEnabled: true,
      // The base every sent field was read from: the server keeps the stored provider, model and
      // language, and answers 409 when the switch changed meanwhile.
      base: {
        provider: SAVED.provider,
        model: SAVED.model,
        language: SAVED.language,
        exploreEnabled: false,
      },
    });

    // The settings the save brings back must not refill the form: the unsaved name edit stays.
    rerender(card({ ...SAVED, exploreEnabled: true }, onSave));
    await waitFor(() => expect(exploreSwitch().getAttribute('aria-checked')).toBe('true'));
    expect(botNameField().value).toBe('Draft name');
  });

  it('the switch is usable again as soon as the save resolves, without waiting for the refetch', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(exploreSwitch().disabled).toBe(false));
    expect(exploreSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('puts the switch back and shows the error when the save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => {
      throw new ApiClientError('Settings changed while saving; reload and try again', 'settings_conflict', 409);
    });
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain('Settings changed while saving'));
    expect(exploreSwitch().getAttribute('aria-checked')).toBe('false');
    expect(exploreSwitch().disabled).toBe(false);
  });

  it('a failed save puts the switch back to the value the server has now', async () => {
    const user = userEvent.setup();
    let failSave: (err: unknown) => void = () => {};
    const onSave = vi.fn((_next: SettingsUpdate) => new Promise<void>((_resolve, reject) => {
      failSave = reject;
    }));
    const { rerender } = renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    // Another admin turned the switch on: the settings that come back carry it.
    rerender(card({ ...SAVED, exploreEnabled: true }, onSave));
    await waitFor(() => expect(exploreSwitch().getAttribute('aria-checked')).toBe('true'));

    failSave(new ApiClientError('Settings changed while saving; reload and try again', 'settings_conflict', 409));

    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain('Settings changed while saving'));
    // The switch shows the value the server has, not the one it had when the save started.
    expect(exploreSwitch().getAttribute('aria-checked')).toBe('true');
    expect(exploreSwitch().disabled).toBe(false);
  });

  it('a second click that fails before the refetch keeps the value the first click saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    onSave.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiClientError('Server error', 'internal', 500));
    // The settings never refetch here: the card only knows what its own saves did.
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());
    await waitFor(() => expect(exploreSwitch().getAttribute('aria-checked')).toBe('true'));
    await user.click(exploreSwitch());

    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain('Server error'));
    expect(onSave.mock.calls[1]?.[0].base?.exploreEnabled).toBe(true);
    expect(exploreSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('leaves exploreEnabled out of the form save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('exploreEnabled');
  });
});

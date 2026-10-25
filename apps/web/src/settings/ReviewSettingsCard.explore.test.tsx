import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '@mergepilot/app/contract';
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
const card = (settings: Settings, onSave: (next: Settings) => Promise<void>) => (
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
    const onSave = vi.fn(async (_next: Settings) => undefined);
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
      base: { exploreEnabled: false },
    });

    // The settings the save brings back must not refill the form: the unsaved name edit stays.
    rerender(card({ ...SAVED, exploreEnabled: true }, onSave));
    await waitFor(() => expect(exploreSwitch().getAttribute('aria-checked')).toBe('true'));
    expect(botNameField().value).toBe('Draft name');
  });

  it('waits for the settings that carry the saved value before the switch can be used again', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: Settings) => undefined);
    const { rerender } = renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(exploreSwitch().disabled).toBe(true);

    rerender(card({ ...SAVED, exploreEnabled: true }, onSave));
    await waitFor(() => expect(exploreSwitch().disabled).toBe(false));
  });

  it('puts the switch back and shows the error when the save fails', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: Settings) => {
      throw new ApiClientError('Settings changed while saving; reload and try again', 'settings_conflict', 409);
    });
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(exploreSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain('Settings changed while saving'));
    expect(exploreSwitch().getAttribute('aria-checked')).toBe('false');
    expect(exploreSwitch().disabled).toBe(false);
  });

  it('leaves exploreEnabled out of the form save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: Settings) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('exploreEnabled');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';
import { api } from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { renderSettings } from './settings.fixtures.js';
import { MAIN_SETTINGS } from './bots/bots-test-utils.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn() } };
});

const SAVED: Settings = { ...MAIN_SETTINGS, mainBotActive: true };
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
const mainSwitch = () => screen.getByRole('switch', { name: 'Main bot active' }) as HTMLButtonElement;

describe('the main bot on/off switch (migration 0021)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue({ models: [] });
  });

  it('saves mainBotActive at once with the base it was read from', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');
    expect(mainSwitch().getAttribute('aria-checked')).toBe('true');

    await user.click(mainSwitch());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      mainBotActive: false,
      base: { provider: 'openrouter', model: 'main/model', language: 'en', mainBotActive: true },
    });
    await waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('false'));
  });

  it('puts the switch back on a failed save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => { throw new Error('conflict'); });
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(mainSwitch());

    await waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));
    expect((await screen.findByRole('alert')).textContent).toContain('conflict');
  });
});

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

const SAVED: Settings = { ...MAIN_SETTINGS, exploreEnabled: false, monthlyBudgetUsd: 50, callTimeoutMs: 600_000 };

/** The main bot's card with the given settings and save. */
const card = (settings: Settings, onSave: (next: SettingsUpdate) => Promise<void>, isMember = false, isSaving = false) => (
  <ToastProvider>
    <ReviewSettingsCard
      workspaceId="ws-1"
      settings={settings}
      isLoading={false}
      isMember={isMember}
      onSave={onSave}
      isSaving={isSaving}
      keyedProviders={['openrouter']}
    />
  </ToastProvider>
);

const timeoutField = () => screen.getByRole('textbox', { name: 'Call timeout (seconds)' }) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: 'Save settings' });

describe('the main bot call timeout (ADR-0048)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue({ models: [] });
  });

  it('shows the saved timeout in seconds', () => {
    renderSettings(card(SAVED, vi.fn(async () => undefined)), 'en');
    expect(timeoutField().value).toBe('600');
  });

  it('sends the typed timeout in milliseconds with the base it was read from', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), '90');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      callTimeoutMs: 90_000,
      // The base the timeout was read from: the server refuses a stale edit.
      base: { callTimeoutMs: 600_000 },
    });
  });

  it('an empty field resets the timeout to inherit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ callTimeoutMs: null, base: { callTimeoutMs: 600_000 } });
  });

  it('leaves the timeout out of a save that did not change it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const body = onSave.mock.calls[0]?.[0] as SettingsUpdate;
    expect(body).not.toHaveProperty('callTimeoutMs');
    expect(body).not.toHaveProperty('base');
  });

  it('keeps the milliseconds of a timeout with fractions', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    const { rerender } = renderSettings(card({ ...SAVED, callTimeoutMs: null }, onSave), 'en');
    expect(timeoutField().value).toBe('');

    await user.type(timeoutField(), '1.5');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ callTimeoutMs: 1_500, base: { callTimeoutMs: null } });

    // The stored 1500 ms comes back as 1.5 seconds.
    rerender(card({ ...SAVED, callTimeoutMs: 1_500 }, onSave));
    await waitFor(() => expect(timeoutField().value).toBe('1.5'));
  });

  it('refuses a value that is not a number', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), 'abc');
    await user.click(saveButton());

    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText('Enter a number of seconds, like 90 or 1.5.')).toBeDefined();
    expect(timeoutField().getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a timeout out of range instead of clamping it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), '2000');
    await user.click(saveButton());

    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText('Enter a timeout between 1 and 1200 seconds.')).toBeDefined();
  });

  it('refuses a fraction of a millisecond', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), '1.5001');
    await user.click(saveButton());

    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText('Enter a number of seconds, like 90 or 1.5.')).toBeDefined();
  });

  it('members cannot change the timeout', () => {
    renderSettings(card(SAVED, vi.fn(async () => undefined), true), 'en');
    expect(timeoutField().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('disables the timeout while a save is pending', () => {
    renderSettings(card(SAVED, vi.fn(async () => undefined), false, true), 'en');
    expect(timeoutField().disabled).toBe(true);
  });

  it('a server update moves the field', async () => {
    const { rerender } = renderSettings(card(SAVED, vi.fn(async () => undefined)), 'en');
    expect(timeoutField().value).toBe('600');

    rerender(card({ ...SAVED, callTimeoutMs: 900_000 }, vi.fn(async () => undefined)));

    await waitFor(() => expect(timeoutField().value).toBe('900'));
  });

  it('an unrelated refetch keeps the unsaved timeout', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    const { rerender } = renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), '90');

    // The same settings come back from a refetch.
    rerender(card({ ...SAVED }, onSave));
    expect(timeoutField().value).toBe('90');
  });

  it('a failed save keeps the typed timeout', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => {
      throw new ApiClientError('Settings changed while saving; reload and try again', 'settings_conflict', 409);
    });
    renderSettings(card(SAVED, onSave), 'en');

    await user.clear(timeoutField());
    await user.type(timeoutField(), '90');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(timeoutField().value).toBe('90');
  });

  it('the exploration switch leaves the timeout out', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (_next: SettingsUpdate) => undefined);
    renderSettings(card(SAVED, onSave), 'en');

    await user.click(screen.getByRole('switch', { name: 'Explore the repository' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('callTimeoutMs');
  });
});

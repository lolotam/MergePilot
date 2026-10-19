import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, ApiClientError } from '../../api/client.js';
import { CATALOG, extraBot, fakeBotsServer, MAIN_SETTINGS, renderPanel } from './bots-test-utils.js';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn() } };
});

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
const openTab = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(await screen.findByRole('tab', { name }));
};

describe('Reviewer panel settings (bot tabs)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue(CATALOG);
  });

  it('shows the main bot then the extra bots in slot order, each with its active dot', async () => {
    fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', active: true }), extraBot(4, { name: 'Fox bot', logo: 'fox' })] });
    renderPanel();
    await screen.findByRole('tab', { name: /Fox bot/ });
    expect(tabNames()).toEqual(['MergePilotActive', 'Owl botActive', 'Fox botInactive']);
    const dots = screen.getAllByTestId('bot-active-dot').map((d) => d.getAttribute('data-active'));
    expect(dots).toEqual(['true', 'true', 'false']);
    expect(screen.getByRole('tab', { name: /MergePilot/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: /Add bot/ })).toBeDefined();
  });

  it('hides "Add bot" once there are 5 bots', async () => {
    fakeBotsServer({ bots: [2, 3, 4, 5].map((slot) => extraBot(slot)) });
    renderPanel();
    await screen.findByRole('tab', { name: /Extra 5/ });
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /Add bot/ })).toBeNull();
  });

  it('adds a bot in the first free slot with the main model, then opens its new tab', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Bot 3', logo: 'owl' })] });
    renderPanel();
    await screen.findByRole('tab', { name: /Bot 3/ });
    await user.click(screen.getByRole('button', { name: /Add bot/ }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toEqual({
      method: 'PUT',
      path: '/api/workspaces/ws-1/bots/3',
      // "Bot 3" is taken by slot 2, so the next free number; pilot and owl are used, so fox.
      body: {
        name: 'Bot 4',
        logo: 'fox',
        active: false,
        provider: 'openrouter',
        model: 'main/model',
        effort: 'high',
        fallback: [{ provider: 'openrouter', model: 'fb/one', effort: null }],
      },
    });
    const tab = await screen.findByRole('tab', { name: /Bot 4/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Bot name') as HTMLInputElement).value).toBe('Bot 4');
  });

  it('"Copy from main bot" fills the form without saving; Save then sends it', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel();
    await openTab(user, /Owl bot/);
    await user.click(screen.getByRole('button', { name: 'Copy from main bot' }));
    expect(screen.getByRole('status').textContent).toMatch(/main bot's model was copied/);
    // The bot's model, then the copied fallback's model.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Model name' }).map((b) => b.textContent)).toEqual(['Main Model▾', 'Fallback One▾']));
    expect(server.writes()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Save bot' }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toEqual({
      name: 'Owl bot',
      logo: 'owl',
      active: false,
      provider: 'openrouter',
      model: 'main/model',
      effort: 'high',
      fallback: [{ provider: 'openrouter', model: 'fb/one', effort: null }],
      skillId: null,
    });
  });

  it('the active switch saves the bot at once', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', active: false })] });
    renderPanel();
    await openTab(user, /Owl bot/);
    const toggle = screen.getByRole('switch', { name: 'Bot active' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ method: 'PUT', path: '/api/workspaces/ws-1/bots/2', body: { name: 'Owl bot', active: true } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Bot active' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('deletes a bot only after the confirm dialog, then shows the main bot', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel();
    await openTab(user, /Owl bot/);
    await user.click(screen.getByRole('button', { name: 'Delete bot' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Delete "Owl bot"?');
    expect(server.writes()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.writes()).toEqual([{ method: 'DELETE', path: '/api/workspaces/ws-1/bots/2', body: undefined }]));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Owl bot/ })).toBeNull());
    expect(screen.getByRole('tab', { name: /MergePilot/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a 409 bot_name_taken inline on the name field', async () => {
    fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })], takenName: 'Hidden twin' });
    renderPanel();
    await openTab(user, /Owl bot/);
    const name = screen.getByLabelText('Bot name');
    await user.clear(name);
    await user.type(name, 'Hidden twin');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));
    expect(await screen.findByText('Another bot in this workspace already has this name')).toBeDefined();
    expect(name.getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a name another bot already has before calling the server', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel();
    await openTab(user, /Owl bot/);
    const name = screen.getByLabelText('Bot name');
    await user.clear(name);
    await user.type(name, 'mergepilot');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));
    expect(screen.getByText('Another bot in this workspace already has this name')).toBeDefined();
    expect(server.writes()).toHaveLength(0);
  });

  it('members see every bot read-only: no Add, Save, Copy or Delete', async () => {
    fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel({ isMember: true, keyedProviders: undefined });
    await screen.findByRole('tab', { name: /Owl bot/ });
    expect(screen.queryByRole('button', { name: /Add bot/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect((screen.getByLabelText('Bot name') as HTMLInputElement).disabled).toBe(true);

    await openTab(user, /Owl bot/);
    expect(screen.queryByRole('button', { name: 'Save bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy from main bot' })).toBeNull();
    expect((screen.getByLabelText('Bot name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Bot active' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: 'One consensus review' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('the main tab saves its name and logo with the settings; its switch is locked on', async () => {
    fakeBotsServer();
    const { onSave } = renderPanel();
    const toggle = screen.getByRole('switch', { name: 'Bot active' }) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(toggle.closest('[title]')?.getAttribute('title')).toBe('The main bot is always on; use pause to stop reviews');

    const name = screen.getByLabelText('Bot name');
    await user.clear(name);
    await user.type(name, 'Captain');
    await user.click(screen.getByRole('radio', { name: 'Star' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ botName: 'Captain', botLogo: 'star', model: 'main/model' }));
  });

  it('the main tab shows a taken name inline', async () => {
    fakeBotsServer();
    const onSave = vi.fn(async () => {
      throw new ApiClientError('taken', 'bot_name_taken', 409);
    });
    renderPanel({ onSave });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Another bot in this workspace already has this name')).toBeDefined();
  });

  it('a panel output change keeps unsaved edits in the main bot form', async () => {
    fakeBotsServer();
    renderPanel();
    const name = (await screen.findByRole('textbox', { name: 'Bot name' })) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Draft name');
    await user.click(screen.getByRole('radio', { name: 'One consensus review' }));
    await screen.findByRole('combobox', { name: 'Minimum agreement' });
    expect(((await screen.findByRole('textbox', { name: 'Bot name' })) as HTMLInputElement).value).toBe('Draft name');
  });

  it('discards an unsaved main bot draft after a conflict even if the shown server fields stayed the same', async () => {
    fakeBotsServer();
    renderPanel({ onSave: async () => { throw new ApiClientError('conflict', 'settings_conflict', 409); } });
    const name = (await screen.findByRole('textbox', { name: 'Bot name' })) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Stale draft');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(name.value).toBe(MAIN_SETTINGS.botName));
  });

  it('panel output: the mode radio and the minimum agreement save; agreement shows in consensus only', async () => {
    const server = fakeBotsServer();
    renderPanel();
    expect((screen.getByRole('radio', { name: 'Each bot posts its own review' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Minimum agreement' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'One consensus review' }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({
      method: 'PUT',
      path: '/api/workspaces/ws-1/settings',
      body: { provider: MAIN_SETTINGS.provider, model: MAIN_SETTINGS.model, language: 'en', panelMode: 'consensus', expectedVersion: 'version-0' },
    });
    expect(screen.getByText('Critical and high findings are always kept')).toBeDefined();

    const agreement = await screen.findByRole('combobox', { name: 'Minimum agreement' });
    await waitFor(() => expect((agreement as HTMLSelectElement).disabled).toBe(false));
    await user.selectOptions(agreement, '3');
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1]?.body).toMatchObject({ panelMinAgreement: 3, expectedVersion: 'version-1' });

    await waitFor(() => expect((screen.getByRole('radio', { name: 'Each bot posts its own review' }) as HTMLInputElement).disabled).toBe(false));
    await user.click(screen.getByRole('radio', { name: 'Each bot posts its own review' }));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Minimum agreement' })).toBeNull());
  });
});

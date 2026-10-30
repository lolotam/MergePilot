import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client.js';
import { CATALOG, extraBot, fakeBotsServer, renderPanel } from './bots-test-utils.js';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn() } };
});

const timeoutField = () => screen.getByRole('textbox', { name: 'Call timeout (seconds)' }) as HTMLInputElement;

describe('an extra bot call timeout (ADR-0048)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue(CATALOG);
  });

  /** Opens the tab of the extra bot in slot 2. */
  const openOwl = async () => {
    await user.click(await screen.findByRole('tab', { name: /Owl bot/ }));
  };

  it('shows the saved timeout in seconds', async () => {
    fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();
    expect(timeoutField().value).toBe('900');
  });

  it('sends the typed timeout in milliseconds', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();

    await user.clear(timeoutField());
    await user.type(timeoutField(), '600');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toMatchObject({ callTimeoutMs: 600_000 });
  });

  it('an empty field resets the timeout to inherit', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();

    await user.clear(timeoutField());
    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toMatchObject({ callTimeoutMs: null });
  });

  it('leaves the timeout out of a save that did not change it', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();

    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).not.toHaveProperty('callTimeoutMs');
  });

  it('the active switch leaves the timeout out', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', active: false, callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();

    await user.click(screen.getByRole('switch', { name: 'Bot active' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).not.toHaveProperty('callTimeoutMs');
    // The server keeps the stored override, so the field still shows it.
    expect(timeoutField().value).toBe('900');
  });

  it('the exploration switch leaves the timeout out', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel();
    await openOwl();

    await user.click(screen.getByRole('switch', { name: 'Explore the repository' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).not.toHaveProperty('callTimeoutMs');
    expect(timeoutField().value).toBe('900');
  });

  it('refuses a value that is not a number', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel();
    await openOwl();

    await user.type(timeoutField(), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    expect(server.writes()).toHaveLength(0);
    expect(await screen.findByText('Enter a number of seconds, like 90 or 1.5.')).toBeDefined();
    expect(timeoutField().getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a timeout out of range instead of clamping it', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })] });
    renderPanel();
    await openOwl();

    await user.type(timeoutField(), '5000');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    expect(server.writes()).toHaveLength(0);
    expect(await screen.findByText('Enter a timeout between 1 and 1200 seconds.')).toBeDefined();
  });

  it('members cannot change the timeout', async () => {
    fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot', callTimeoutMs: 900_000 })] });
    renderPanel({ isMember: true });
    await openOwl();
    expect(timeoutField().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save bot' })).toBeNull();
  });
});

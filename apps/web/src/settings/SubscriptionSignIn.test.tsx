import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, type SubscriptionLogin } from '../api/client.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { SubscriptionSignIn } from './SubscriptionSignIn.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, startSubscription: vi.fn(), getSubscriptionLogin: vi.fn(), answerSubscription: vi.fn(), finishSubscription: vi.fn(), cancelSubscription: vi.fn() } };
});
const state: SubscriptionLogin = { id: 'login-1', provider: 'openai', status: 'pending', expiresAt: '2099-01-01T00:00:00Z', notice: { message: 'Sign in', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelSubscription).mockResolvedValue(undefined);
  vi.mocked(api.startSubscription).mockResolvedValue(state);
  vi.mocked(api.getSubscriptionLogin).mockResolvedValue(state);
});
afterEach(() => vi.restoreAllMocks());

describe('dashboard subscription login', () => {
  it.each(['openai', 'anthropic', 'xai'])('offers API and subscription methods for %s without exposing a token input in subscription mode', async (provider) => {
    const user = userEvent.setup();
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws" />, 'en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Authentication method' }), 'subscription');
    expect(screen.queryByLabelText('Secret API Key')).toBeNull();
    expect(screen.getByRole('button', { name: /Sign in with/ })).toBeDefined();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'gemini');
    expect(screen.queryByRole('combobox', { name: 'Authentication method' })).toBeNull();
    expect(screen.getByLabelText('Secret API Key')).toBeDefined();
  });

  it('shows device instructions, saves a ready login, and closes only after save succeeds', async () => {
    const user = userEvent.setup();
    const connected = vi.fn();
    vi.mocked(api.getSubscriptionLogin).mockResolvedValue({ ...state, status: 'ready' });
    vi.mocked(api.finishSubscription).mockResolvedValue({ ...state, status: 'completed' });
    renderSettings(<SubscriptionSignIn workspaceId="ws" provider="openai" onConnected={connected} />, 'en');
    await user.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }));
    expect(await screen.findByText('ABCD-EFGH')).toBeDefined();
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    expect(api.finishSubscription).toHaveBeenCalledWith('ws', 'login-1');
  });

  it('submits a Claude code with the current prompt id and cancels on unmount', async () => {
    const user = userEvent.setup();
    const claude: SubscriptionLogin = { ...state, provider: 'anthropic', prompt: { id: 'prompt-1', message: 'Paste code' }, notice: { message: 'Sign in', url: 'https://claude.ai/oauth/authorize' } };
    vi.mocked(api.startSubscription).mockResolvedValue(claude);
    vi.mocked(api.getSubscriptionLogin).mockResolvedValue(claude);
    vi.mocked(api.answerSubscription).mockResolvedValue({ ...claude, prompt: undefined });
    const view = renderSettings(<SubscriptionSignIn workspaceId="ws" provider="anthropic" onConnected={vi.fn()} />, 'en');
    await user.click(screen.getByRole('button', { name: /Sign in with Claude/ }));
    await user.type(await screen.findByLabelText('Authorization code'), 'code#state');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.answerSubscription).toHaveBeenCalledWith('ws', 'login-1', 'prompt-1', 'code#state');
    expect((screen.queryByLabelText('Authorization code') as HTMLInputElement | null)?.value ?? '').toBe('');
    view.unmount();
    expect(api.cancelSubscription).toHaveBeenCalledWith('ws', 'login-1');
  });

  it('shows a failed save and provides a new-login action without reporting success', async () => {
    const user = userEvent.setup();
    const connected = vi.fn();
    vi.mocked(api.getSubscriptionLogin).mockResolvedValue({ ...state, status: 'ready' });
    vi.mocked(api.finishSubscription).mockRejectedValue(new Error('Could not save'));
    renderSettings(<SubscriptionSignIn workspaceId="ws" provider="openai" onConnected={connected} />, 'en');
    await user.click(screen.getByRole('button', { name: /Sign in with ChatGPT/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save');
    expect(screen.getByRole('button', { name: 'Start a new sign-in' })).toBeDefined();
    expect(connected).not.toHaveBeenCalled();
  });
});

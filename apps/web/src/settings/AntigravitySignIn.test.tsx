import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, type SubscriptionLogin } from '../api/client.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { SubscriptionSignIn } from './SubscriptionSignIn.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSubscriptionAvailability: vi.fn(),
      startSubscription: vi.fn(),
      getSubscriptionLogin: vi.fn(),
      answerSubscription: vi.fn(),
      finishSubscription: vi.fn(),
      cancelSubscription: vi.fn(),
    },
  };
});

const pending: SubscriptionLogin = {
  id: 'login-g', provider: 'google-antigravity', status: 'pending', expiresAt: '2099-01-01T00:00:00Z',
  notice: { message: 'Sign in', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' },
  prompt: { id: 'prompt-g', message: 'Paste the address' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cancelSubscription).mockResolvedValue(undefined);
  vi.mocked(api.startSubscription).mockResolvedValue(pending);
  vi.mocked(api.getSubscriptionLogin).mockResolvedValue(pending);
});

describe('Google Antigravity sign-in', () => {
  it('starts only after the terms risk is acknowledged, and sends the acknowledgement', async () => {
    const user = userEvent.setup();
    renderSettings(<SubscriptionSignIn workspaceId="ws" provider="google-antigravity" onConnected={vi.fn()} />, 'en');
    expect(screen.getByRole('note').textContent).toMatch(/terms forbid/);
    const signIn = screen.getByRole('button', { name: /Sign in with Google/ });
    expect(signIn).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox', { name: /understand the risk/ }));
    await user.click(signIn);
    expect(api.startSubscription).toHaveBeenCalledWith('ws', 'google-antigravity', true);
  });

  it('asks for the browser address and submits it for the current prompt', async () => {
    const user = userEvent.setup();
    vi.mocked(api.answerSubscription).mockResolvedValue({ ...pending, prompt: undefined });
    renderSettings(<SubscriptionSignIn workspaceId="ws" provider="google-antigravity" onConnected={vi.fn()} />, 'en');
    await user.click(screen.getByRole('checkbox', { name: /understand the risk/ }));
    await user.click(screen.getByRole('button', { name: /Sign in with Google/ }));
    expect(await screen.findByText(/Copy the whole address/)).toBeDefined();
    await user.type(screen.getByLabelText('Address from the browser'), 'http://localhost:51121/oauth-callback?state=s&code=c');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.answerSubscription).toHaveBeenCalledWith('ws', 'login-g', 'prompt-g', 'http://localhost:51121/oauth-callback?state=s&code=c');
  });

  it('shows the translated reason of a failed sign-in', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSubscriptionLogin).mockResolvedValue({ ...pending, prompt: undefined, status: 'failed', error: 'Subscription sign-in failed.', errorCode: 'validation-required' });
    renderSettings(<SubscriptionSignIn workspaceId="ws" provider="google-antigravity" onConnected={vi.fn()} />, 'en');
    await user.click(screen.getByRole('checkbox', { name: /understand the risk/ }));
    await user.click(screen.getByRole('button', { name: /Sign in with Google/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/verify this account/);
  });
});

describe('AddKeyModal with Google Antigravity', () => {
  it('offers the provider only when the server has it configured, with sign-in and no API key field', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSubscriptionAvailability).mockResolvedValue({ providers: ['openai', 'anthropic', 'xai', 'google-antigravity'] });
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws" />, 'en');
    const select = screen.getByRole('combobox', { name: 'Provider' });
    await screen.findByRole('option', { name: 'Google Antigravity' });
    await user.selectOptions(select, 'google-antigravity');
    expect(screen.getByRole('button', { name: /Sign in with Google/ })).toBeDefined();
    expect(screen.queryByLabelText('Secret API Key')).toBeNull();
  });

  it('hides the provider when the server does not offer it', async () => {
    vi.mocked(api.getSubscriptionAvailability).mockResolvedValue({ providers: ['openai', 'anthropic', 'xai'] });
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws" />, 'en');
    await screen.findByRole('option', { name: 'OpenAI' });
    await vi.waitFor(() => expect(api.getSubscriptionAvailability).toHaveBeenCalled());
    expect(screen.queryByRole('option', { name: 'Google Antigravity' })).toBeNull();
  });
});

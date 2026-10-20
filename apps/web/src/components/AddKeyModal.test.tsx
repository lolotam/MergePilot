import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddKeyModal } from './AddKeyModal.js';
import { I18nProvider } from '../i18n/context.js';

vi.mock('../settings/SubscriptionSignIn.js', () => ({
  SubscriptionSignIn: () => <div data-testid="subscription-sign-in">sign-in</div>,
}));

describe('AddKeyModal dual-method providers (ADR-0027)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderModal = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLanguage="en">
          <AddKeyModal
            isOpen
            onClose={() => {}}
            onSubmit={vi.fn()}
            isPending={false}
            workspaceId="ws-1"
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

  it('shows subscription sign-in and the API key field together for dual providers', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.selectOptions(screen.getByLabelText(/Provider/i), 'openai');
    expect(screen.getByTestId('subscription-sign-in')).toBeDefined();
    expect(screen.getByLabelText(/Secret API Key/i)).toBeDefined();
  });
});

describe('AddKeyModal MiniMax key format hint', () => {
  /** Only the prefix matters here, so the rest is filler built at runtime: no secret-like literal in the source. */
  const payAsYouGoKey = (): string => ['sk', 'api', 'k4'.repeat(4)].join('-');

  const renderModal = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLanguage="en">
          <AddKeyModal
            isOpen
            onClose={() => {}}
            onSubmit={vi.fn()}
            isPending={false}
            workspaceId="ws-1"
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

  it('warns about a pay-as-you-go key under MiniMax Coding Plan and still lets the user save', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.selectOptions(screen.getByLabelText(/Provider/i), 'minimax-coding-plan');
    await user.type(screen.getByLabelText(/Secret API Key/i), payAsYouGoKey());

    expect(screen.getByText(/doesn't look like a MiniMax Coding Plan key/)).toBeDefined();
    const saveButton = screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });
});

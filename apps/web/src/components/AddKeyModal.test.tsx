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

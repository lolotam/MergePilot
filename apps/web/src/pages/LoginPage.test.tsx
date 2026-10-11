import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { LoginPage } from './LoginPage.js';
import { I18nProvider } from '../i18n/context.js';
import { authClient } from '../auth/client.js';

vi.mock('../auth/client.js', () => ({
  authClient: {
    signIn: {
      social: vi.fn(),
    },
  },
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(LoginPage, null),
      ),
    );

  it('renders both providers and calls signIn with each', async () => {
    const user = userEvent.setup();
    renderComponent();

    const googleBtn = screen.getByRole('button', { name: /Google/i });
    const githubBtn = screen.getByRole('button', { name: /GitHub/i });

    expect(googleBtn).toBeDefined();
    expect(githubBtn).toBeDefined();

    // Click Google
    await user.click(googleBtn);
    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: 'google',
      callbackURL: '/',
    });

    // Click GitHub
    await user.click(githubBtn);
    expect(authClient.signIn.social).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/',
    });
  });

  it('renders product name and tagline', () => {
    renderComponent();
    expect(screen.getByText('MergePilot')).toBeDefined();
    expect(screen.getByText(/مراجعة طلبات السحب/i)).toBeDefined();
  });
});

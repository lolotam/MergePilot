import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { RootRedirectPage } from './RootRedirectPage.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');

describe('RootRedirectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, { path: '/', element: React.createElement(RootRedirectPage, null) }),
              React.createElement(Route, { path: '/w/:workspaceId', element: React.createElement('div', null, 'Workspace Dashboard') }),
            ),
          ),
        ),
      ),
    );

  it('renders landing page when visitor is signed out', () => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    renderComponent();

    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
    expect(screen.getAllByRole('link', { name: /ابدأ مجانًا|Get started|ثبّت على GitHub|Install on GitHub/i }).length).toBeGreaterThan(0);
  });

  it('redirects to workspace dashboard when user is signed in with a workspace', () => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'test@example.com', name: 'Tester', image: null, githubLinked: true },
        workspaces: [{ id: 'ws-123', name: 'My Workspace', slug: 'my-workspace', role: 'owner' }],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    renderComponent();

    expect(screen.getByText('Workspace Dashboard')).toBeDefined();
  });

  it('renders workspace creation form when user is signed in but has no workspaces', () => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'test@example.com', name: 'Tester', image: null, githubLinked: true },
        workspaces: [],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    renderComponent();

    expect(screen.getByText(/إنشاء مساحة عمل جديدة/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /إنشاء ومتابعة/i })).toBeDefined();
  });
});

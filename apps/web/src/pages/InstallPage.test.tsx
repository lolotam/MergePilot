import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { InstallPage } from './InstallPage.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';
import * as hooks from '../api/hooks.js';
import { api } from '../api/client.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', () => ({
  api: {
    linkInstallation: vi.fn(),
  },
}));

describe('InstallPage - workspace filtering and installation linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setupMocks = ({
    workspaces = [
      { id: 'ws-owner', name: 'Owner Org', slug: 'owner-org', role: 'owner' as const },
      { id: 'ws-admin', name: 'Admin Org', slug: 'admin-org', role: 'admin' as const },
      { id: 'ws-member', name: 'Member Only Org', slug: 'member-org', role: 'member' as const },
    ],
  } = {}) => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'test@example.com', name: 'Tester', image: null, githubLinked: true },
        workspaces,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);
  };

  const renderComponent = (installationId = '123456') =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: [`/install?installation_id=${installationId}`] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, { path: '/install', element: React.createElement(InstallPage, null) }),
            ),
          ),
        ),
      ),
    );

  it('lists only admin and owner workspaces, omitting member workspaces', () => {
    setupMocks();
    renderComponent();

    expect(screen.getByText(/Owner Org/)).toBeDefined();
    expect(screen.getByText(/Admin Org/)).toBeDefined();
    expect(screen.queryByText(/Member Only Org/)).toBeNull();
  });

  it('posts the link and shows success screen on submission', async () => {
    const user = userEvent.setup();
    setupMocks();
    vi.mocked(api.linkInstallation).mockResolvedValueOnce(undefined);

    renderComponent('7890');

    const select = screen.getByLabelText(/اختر مساحة العمل/i);
    await user.selectOptions(select, 'ws-admin');

    const submitBtn = screen.getByRole('button', { name: /تأكيد وربط المساحة/i });
    await user.click(submitBtn);

    expect(api.linkInstallation).toHaveBeenCalledWith('ws-admin', 7890);

    await waitFor(() => {
      expect(screen.getByText(/تم ربط التطبيق بنجاح/i)).toBeDefined();
      expect(screen.getByRole('link', { name: /الانتقال إلى لوحة التحكم/i })).toBeDefined();
    });
  });

  it('shows no eligible workspaces notice when user is only member in all workspaces', () => {
    setupMocks({
      workspaces: [
        { id: 'ws-mem', name: 'Member Org', slug: 'mem-org', role: 'member' as const },
      ],
    });
    renderComponent();

    expect(screen.getByText(/لا توجد مساحات عمل مؤهلة/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /تأكيد وربط المساحة/i })).toBeNull();
  });
});

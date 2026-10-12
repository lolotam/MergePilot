import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { WorkspaceDangerZone } from './WorkspaceDangerZone.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from './Toast.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');

const mockNavigate = vi.fn();
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('WorkspaceDangerZone - delete workspace dialog', () => {
  const mockDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hooks.useDeleteWorkspaceMutation).mockReturnValue({
      mutateAsync: mockDelete,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useDeleteWorkspaceMutation>);
  });

  const renderComponent = (props: {
    workspaceId: string;
    workspaceName: string;
    role: 'owner' | 'admin' | 'member';
  } = { workspaceId: 'ws-1', workspaceName: 'My Team', role: 'owner' }) =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'en' },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(WorkspaceDangerZone, props),
        ),
      ),
    );

  it('renders nothing for non-owners (admin and member)', () => {
    for (const role of ['admin', 'member'] as const) {
      const { unmount } = renderComponent({ workspaceId: 'ws-1', workspaceName: 'My Team', role });
      expect(screen.queryByText(/Danger zone/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /Delete workspace/i })).toBeNull();
      unmount();
    }
  });

  it('renders danger zone for owner', () => {
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'My Team', role: 'owner' });
    expect(screen.getByText(/Danger zone/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Delete workspace/i })).toBeDefined();
  });

  it('opens dialog explaining what is deleted and what is kept', async () => {
    const user = userEvent.setup();
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'My Team', role: 'owner' });

    await user.click(screen.getByRole('button', { name: /Delete workspace/i }));

    expect(screen.getByText(/Delete workspace permanently/i)).toBeDefined();
    // Explanation of what is deleted
    expect(screen.getByText(/Will be deleted:/i)).toBeDefined();
    // Explanation of what is kept (GitHub App remains installed)
    expect(screen.getByText(/What remains: The GitHub App remains installed/i)).toBeDefined();
  });

  it('keeps delete confirmation button disabled until typed name matches exactly', async () => {
    const user = userEvent.setup();
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'My Team', role: 'owner' });

    await user.click(screen.getByRole('button', { name: /Delete workspace/i }));

    const confirmBtn = screen.getByRole('button', {
      name: /I understand the consequences, delete this workspace/i,
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Type workspace name to confirm/i);

    // Typing partial or wrong name
    await user.type(input, 'My Te');
    expect(confirmBtn.disabled).toBe(true);

    await user.type(input, 'am Wrong');
    expect(confirmBtn.disabled).toBe(true);

    // Typing exact match
    await user.clear(input);
    await user.type(input, 'My Team');
    expect(confirmBtn.disabled).toBe(false);
  });

  it('submits delete mutation when confirmed and navigates to /', async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValueOnce(undefined);
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'My Team', role: 'owner' });

    await user.click(screen.getByRole('button', { name: /Delete workspace/i }));

    const input = screen.getByPlaceholderText(/Type workspace name to confirm/i);
    await user.type(input, 'My Team');

    const confirmBtn = screen.getByRole('button', {
      name: /I understand the consequences, delete this workspace/i,
    });
    await user.click(confirmBtn);

    expect(mockDelete).toHaveBeenCalledWith('My Team');
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});

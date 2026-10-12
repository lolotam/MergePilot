import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { WorkspaceGeneralCard } from './WorkspaceGeneralCard.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from './Toast.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');

describe('WorkspaceGeneralCard - rename workspace form', () => {
  const mockRename = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hooks.useRenameWorkspaceMutation).mockReturnValue({
      mutateAsync: mockRename,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useRenameWorkspaceMutation>);
  });

  const renderComponent = (props = { workspaceId: 'ws-1', workspaceName: 'Current Team', isMember: false }) =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'en' },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(WorkspaceGeneralCard, props),
        ),
      ),
    );

  it('renders with current workspace name', () => {
    renderComponent();
    const input = screen.getByLabelText(/Workspace name/i) as HTMLInputElement;
    expect(input.value).toBe('Current Team');
  });

  it('allows admin/owner to rename workspace with valid trimmed name', async () => {
    const user = userEvent.setup();
    mockRename.mockResolvedValueOnce({ id: 'ws-1', name: 'New Team Name' });
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'Current Team', isMember: false });

    const input = screen.getByLabelText(/Workspace name/i);
    const saveButton = screen.getByRole('button', { name: /Rename workspace/i });

    await user.clear(input);
    await user.type(input, '   New Team Name   ');
    await user.click(saveButton);

    expect(mockRename).toHaveBeenCalledWith('New Team Name');
  });

  it('validates name: rejects empty or > 60 chars', async () => {
    const user = userEvent.setup();
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'Current Team', isMember: false });

    const input = screen.getByLabelText(/Workspace name/i);
    const saveButton = screen.getByRole('button', { name: /Rename workspace/i });

    // Empty
    await user.clear(input);
    await user.click(saveButton);
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText(/Workspace name is required/i)).toBeDefined();

    // Greater than 60 chars
    await user.clear(input);
    await user.type(input, 'a'.repeat(61));
    await user.click(saveButton);
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText(/Workspace name is required/i)).toBeDefined();
  });

  it('disables input and hides/disables save button for member', () => {
    renderComponent({ workspaceId: 'ws-1', workspaceName: 'Current Team', isMember: true });

    const input = screen.getByLabelText(/Workspace name/i) as HTMLInputElement;
    expect(input.disabled).toBe(true);

    const saveButton = screen.queryByRole('button', { name: /Rename workspace/i });
    expect(saveButton === null || (saveButton as HTMLButtonElement).disabled).toBe(true);
  });
});

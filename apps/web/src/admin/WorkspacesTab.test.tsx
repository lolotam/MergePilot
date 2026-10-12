import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adminApi } from '../api/admin.js';
import { WorkspacesTab } from './WorkspacesTab.js';
import { renderWithProviders, workspacesFixture } from './admin-test-utils.js';

vi.mock('../api/admin.js', () => ({
  adminApi: {
    getWorkspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
  },
}));

describe('WorkspacesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminApi.getWorkspaces).mockResolvedValue(workspacesFixture);
    vi.mocked(adminApi.deleteWorkspace).mockResolvedValue(undefined);
  });

  it('shows installations, providers, runs and cost', async () => {
    renderWithProviders(<WorkspacesTab />);
    expect(await screen.findByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('acme-org')).toBeTruthy();
    expect(screen.getByText('Suspended')).toBeTruthy();
    expect(screen.getByText('anthropic')).toBeTruthy();
    expect(screen.getByText('sara@example.com')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });

  it('delete stays disabled until the exact workspace name is typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesTab />);

    await user.click(await screen.findByRole('button', { name: 'Delete workspace: Acme Corp' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete workspace' });
    const input = within(dialog).getByRole('textbox');

    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, 'acme corp');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(adminApi.deleteWorkspace).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'Acme Corp');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);

    expect(adminApi.deleteWorkspace).toHaveBeenCalledWith('ws-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancel closes the dialog without deleting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesTab />);

    await user.click(await screen.findByRole('button', { name: 'Delete workspace: Acme Corp' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adminApi.deleteWorkspace).not.toHaveBeenCalled();
  });
});

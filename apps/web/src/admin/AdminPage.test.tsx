import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adminApi } from '../api/admin.js';
import { ApiClientError } from '../api/client.js';
import * as hooks from '../api/hooks.js';
import { AdminPage } from './AdminPage.js';
import {
  meFixture,
  overviewFixture,
  renderWithProviders,
  runsFixture,
  usersFixture,
  workspacesFixture,
} from './admin-test-utils.js';

vi.mock('../api/hooks.js');
vi.mock('../api/admin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/admin.js')>()),
  adminApi: {
    getOverview: vi.fn(),
    getUsers: vi.fn(),
    getWorkspaces: vi.fn(),
    getRuns: vi.fn(),
    deleteUser: vi.fn(),
    deleteWorkspace: vi.fn(),
    getMaintenance: vi.fn(),
    runRetention: vi.fn(),
  },
}));

function mockMe(isPlatformAdmin: boolean, isLoading = false) {
  vi.mocked(hooks.useMeQuery).mockReturnValue({
    data: isLoading ? undefined : meFixture(isPlatformAdmin),
    isLoading,
  } as unknown as ReturnType<typeof hooks.useMeQuery>);
}

describe('AdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminApi.getOverview).mockResolvedValue(overviewFixture);
    vi.mocked(adminApi.getUsers).mockResolvedValue(usersFixture);
    vi.mocked(adminApi.getWorkspaces).mockResolvedValue(workspacesFixture);
    vi.mocked(adminApi.getRuns).mockResolvedValue(runsFixture);
    vi.mocked(adminApi.deleteUser).mockResolvedValue(undefined);
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: null } });
  });

  it('redirects non-admins to / without calling the admin API', async () => {
    mockMe(false);
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText('home page')).toBeTruthy();
    expect(adminApi.getOverview).not.toHaveBeenCalled();
  });

  it('waits for /api/me before deciding', () => {
    mockMe(false, true);
    renderWithProviders(<AdminPage />);
    expect(screen.queryByText('home page')).toBeNull();
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders the four tabs and overview stat cards for a platform admin', async () => {
    mockMe(true);
    renderWithProviders(<AdminPage />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Users',
      'Workspaces',
      'Review Runs',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');

    expect(await screen.findByText('Total Users')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('Linked: 4 · Pending: 2')).toBeTruthy();
  });

  it('users tab lists providers as badges and searches by name or email on the server', async () => {
    mockMe(true);
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    expect(await screen.findByText('Sara Ali')).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(adminApi.getUsers).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });

    // The term arrives in one input event, so the result never depends on typing speed; the
    // debounce itself is covered with fake timers in hooks.test.tsx.
    const search = screen.getByPlaceholderText('Search users by name or email...');
    await user.click(search);
    await user.paste('SARA@');
    await waitFor(() =>
      expect(adminApi.getUsers).toHaveBeenLastCalledWith({ limit: 50, offset: 0, q: 'SARA@' }),
    );
    const terms = vi.mocked(adminApi.getUsers).mock.calls.map(([params]) => params?.q);
    expect(terms.filter((q) => q !== undefined)).toEqual(['SARA@']);

    vi.mocked(adminApi.getUsers).mockResolvedValue({ ...usersFixture, users: [], total: 0 });
    await user.clear(search);
    await user.paste('nobody');
    expect(await screen.findByText('No users found.')).toBeTruthy();
    expect(adminApi.getUsers).toHaveBeenLastCalledWith({ limit: 50, offset: 0, q: 'nobody' });
  });

  it('cannot delete yourself; deleting another user asks for confirmation first', async () => {
    mockMe(true);
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await screen.findByText('Sara Ali');
    const selfDelete = screen.getByRole('button', { name: 'Delete user: Ops' }) as HTMLButtonElement;
    expect(selfDelete.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Delete user: Sara Ali' }));
    const dialog = screen.getByRole('dialog');
    expect(adminApi.deleteUser).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    expect(adminApi.deleteUser).toHaveBeenCalledWith('u-sara');
  });

  it('runs tab shows runs across workspaces and filters by workspace name on the server', async () => {
    mockMe(true);
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Review Runs' }));
    expect(await screen.findByText('acme/backend')).toBeTruthy();
    expect(screen.getByRole('link', { name: /#42/ }).getAttribute('href')).toBe(
      'https://github.com/acme/backend/pull/42',
    );
    expect(adminApi.getRuns).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    expect(adminApi.getWorkspaces).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('Filter by workspace name...'), 'acme');
    await waitFor(() =>
      expect(adminApi.getRuns).toHaveBeenLastCalledWith({
        limit: 50,
        offset: 0,
        workspaceQuery: 'acme',
      }),
    );
  });

  it('explains a refused delete when the user solely owns shared workspaces', async () => {
    mockMe(true);
    vi.mocked(adminApi.deleteUser).mockRejectedValue(
      new ApiClientError('refused', 'sole_owner_of_shared_workspace', 409, {
        workspaces: [{ id: 'ws-1', name: 'Acme Corp' }],
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await screen.findByText('Sara Ali');
    await user.click(screen.getByRole('button', { name: 'Delete user: Sara Ali' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete user' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Sara Ali was not deleted')).toBeTruthy();
    expect(within(alert).getByText(/transfer their ownership/)).toBeTruthy();
    expect(within(alert).getByText('Acme Corp')).toBeTruthy();
    expect(screen.queryByText('refused')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

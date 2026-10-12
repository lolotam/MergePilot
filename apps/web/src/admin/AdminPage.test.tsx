import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adminApi } from '../api/admin.js';
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
vi.mock('../api/admin.js', () => ({
  adminApi: {
    getOverview: vi.fn(),
    getUsers: vi.fn(),
    getWorkspaces: vi.fn(),
    getRuns: vi.fn(),
    deleteUser: vi.fn(),
    deleteWorkspace: vi.fn(),
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

  it('users tab lists providers as badges and filters by name or email', async () => {
    mockMe(true);
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Users' }));
    expect(await screen.findByText('Sara Ali')).toBeTruthy();
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();

    await user.type(screen.getByPlaceholderText('Search users by name or email...'), 'SARA@');
    expect(screen.getByText('Sara Ali')).toBeTruthy();
    expect(screen.queryByText('ops@test.com')).toBeNull();

    await user.clear(screen.getByPlaceholderText('Search users by name or email...'));
    await user.type(screen.getByPlaceholderText('Search users by name or email...'), 'nobody');
    expect(screen.getByText('No users found.')).toBeTruthy();
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

  it('runs tab shows runs across workspaces', async () => {
    mockMe(true);
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />);

    await user.click(screen.getByRole('tab', { name: 'Review Runs' }));
    expect(await screen.findByText('acme/backend')).toBeTruthy();
    expect(screen.getByRole('link', { name: /#42/ }).getAttribute('href')).toBe(
      'https://github.com/acme/backend/pull/42',
    );
    expect(screen.getByRole('option', { name: 'Acme Corp' })).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import * as hooks from '../api/hooks.js';
import { Layout } from '../components/Layout.js';
import { meFixture, renderWithProviders } from './admin-test-utils.js';

vi.mock('../api/hooks.js');
vi.mock('../auth/client.js', () => ({ authClient: { signOut: vi.fn() } }));

function mockMe(isPlatformAdmin: boolean) {
  vi.mocked(hooks.useMeQuery).mockReturnValue({
    data: meFixture(isPlatformAdmin),
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useMeQuery>);
}

describe('Layout avatar menu: platform admin entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openAvatarMenu() {
    const avatar = document.querySelector('button[aria-haspopup="menu"]') as HTMLElement;
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(avatar);
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeDefined();
  }

  it('is not in the page at all for users who are not platform admins', () => {
    mockMe(false);
    renderWithProviders(<Layout />, { path: '/w/ws-1' });
    expect(screen.queryByRole('link', { name: 'Platform Admin' })).toBeNull();
    openAvatarMenu();
    expect(screen.queryByRole('menuitem', { name: 'Platform Admin' })).toBeNull();
  });

  it('lives only inside the avatar menu and links to /admin for platform admins', () => {
    mockMe(true);
    renderWithProviders(<Layout />, { path: '/w/ws-1' });
    expect(screen.queryByRole('link', { name: 'Platform Admin' })).toBeNull();
    openAvatarMenu();
    const item = screen.getByRole('menuitem', { name: 'Platform Admin' });
    expect(item.getAttribute('href')).toBe('/admin');
  });
});

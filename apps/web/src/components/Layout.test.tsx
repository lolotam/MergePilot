import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Layout } from './Layout.js';
import { I18nProvider } from '../i18n/context.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');
vi.mock('../auth/client.js', () => ({ authClient: { signOut: vi.fn() } }));

function mockMe(isPlatformAdmin = false) {
  vi.mocked(hooks.useMeQuery).mockReturnValue({
    data: {
      user: {
        id: 'u-1',
        name: 'Alex Developer',
        email: 'alex@example.com',
        image: null,
        githubLinked: true,
      },
      workspaces: [
        { id: 'ws-1', name: 'Acme Corp', slug: 'acme-corp', role: 'owner' as const },
        { id: 'ws-2', name: 'Beta Lab', slug: 'beta-lab', role: 'member' as const },
      ],
      isPlatformAdmin,
    },
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useMeQuery>);
}

describe('Layout component - Leap inspired app shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMe();
  });

  const renderLayout = (initialPath = '/w/ws-1', initialLanguage: 'ar' | 'en' = 'en') =>
    render(
      <I18nProvider initialLanguage={initialLanguage}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/w/:workspaceId" element={<div>Overview Content</div>} />
              <Route path="/w/:workspaceId/repos" element={<div>Repos Content</div>} />
              <Route path="/w/:workspaceId/runs" element={<div>Runs Content</div>} />
              <Route path="/w/:workspaceId/team" element={<div>Team Content</div>} />
              <Route path="/w/:workspaceId/settings" element={<div>Settings Content</div>} />
              <Route path="/admin" element={<div>Admin Content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

  it('sidebar active item marked with aria-current="page"', () => {
    renderLayout('/w/ws-1/repos');

    // The nav item linking to /w/ws-1/repos should have aria-current="page"
    const reposLinks = screen.getAllByRole('link', { name: /Repositories|المستودعات/i });
    const activeLink = reposLinks.find((l) => l.getAttribute('aria-current') === 'page');
    expect(activeLink).toBeDefined();
    expect(activeLink?.getAttribute('href')).toBe('/w/ws-1/repos');

    // Overview link should not have aria-current="page"
    const overviewLinks = screen.getAllByRole('link', { name: /Overview|نظرة عامة/i });
    const overviewActive = overviewLinks.find((l) => l.getAttribute('aria-current') === 'page');
    expect(overviewActive).toBeUndefined();
  });

  it('mobile menu button toggles the drawer', () => {
    renderLayout('/w/ws-1');

    const mobileMenuButton = screen.getByRole('button', { name: /menu|open menu|toggle menu|قائمة/i });
    expect(mobileMenuButton).toBeDefined();

    // Drawer should initially be closed or have aria-expanded false
    expect(mobileMenuButton.getAttribute('aria-expanded')).toBe('false');

    // Click to open drawer
    fireEvent.click(mobileMenuButton);
    expect(mobileMenuButton.getAttribute('aria-expanded')).toBe('true');

    // Drawer container or backdrop should be open
    const drawer = screen.getByTestId('mobile-drawer');
    expect(drawer).toBeDefined();

    // Click again to close drawer
    fireEvent.click(mobileMenuButton);
    expect(mobileMenuButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('menus inside the open mobile drawer keep working (single sidebar instance)', () => {
    renderLayout('/w/ws-1');
    fireEvent.click(screen.getByRole('button', { name: /menu|open menu|toggle menu|قائمة/i }));

    const drawer = screen.getByTestId('mobile-drawer');
    const avatarButtons = document.querySelectorAll('button[aria-haspopup="menu"]');
    expect(avatarButtons).toHaveLength(1);
    expect(drawer.contains(avatarButtons[0] as Node)).toBe(true);

    fireEvent.click(avatarButtons[0] as HTMLElement);
    const menu = screen.getByRole('menu');
    const firstItem = menu.querySelector('[role="menuitem"]') as HTMLElement;
    fireEvent.mouseDown(firstItem);
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('breadcrumb renders the current page', () => {
    renderLayout('/w/ws-1/settings');

    const breadcrumb = screen.getByLabelText(/breadcrumb|مسار التنقل/i);
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb.textContent).toContain('Settings');
  });
});

import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type {
  AdminOverview,
  AdminRunsResponse,
  AdminUsersResponse,
  AdminWorkspacesResponse,
} from '../api/admin.js';
import type { MeResponseWithAdmin } from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider, type Language } from '../i18n/context.js';

// Test-only fixtures for the platform admin pages.

export function meFixture(isPlatformAdmin: boolean): MeResponseWithAdmin {
  return {
    user: { id: 'u-admin', email: 'ops@test.com', name: 'Ops', image: null, githubLinked: false },
    workspaces: [{ id: 'ws-1', name: 'Acme Corp', slug: 'acme-corp', role: 'owner' }],
    isPlatformAdmin,
  };
}

export const overviewFixture: AdminOverview = {
  users: 12,
  workspaces: 5,
  installations: { linked: 4, pending: 2 },
  repositories: 9,
  reviewRuns: { total: 40, last7Days: 7, byStatus: { completed: 30, failed: 10 } },
  costUsd: { allTime: 12.5, last30Days: 3.25 },
};

export const usersFixture: AdminUsersResponse = {
  users: [
    {
      id: 'u-admin',
      name: 'Ops',
      email: 'ops@test.com',
      emailVerified: true,
      image: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      signInProviders: ['google'],
      lastSessionAt: '2026-10-11T10:00:00.000Z',
      workspaces: [],
    },
    {
      id: 'u-sara',
      name: 'Sara Ali',
      email: 'sara@example.com',
      emailVerified: false,
      image: null,
      createdAt: '2026-10-02T10:00:00.000Z',
      signInProviders: ['github', 'google'],
      lastSessionAt: null,
      workspaces: [{ id: 'ws-1', name: 'Acme Corp', role: 'owner' }],
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

export const workspacesFixture: AdminWorkspacesResponse = {
  workspaces: [
    {
      id: 'ws-1',
      name: 'Acme Corp',
      slug: 'acme-corp',
      createdAt: '2026-10-01T10:00:00.000Z',
      memberCount: 3,
      ownerEmail: 'sara@example.com',
      installations: [
        { id: 101, accountLogin: 'acme-org', repositorySelection: 'all', suspended: true },
      ],
      providers: ['anthropic'],
      runsCount: 7,
      costUsdTotal: 1.5,
      lastRunAt: '2026-10-10T10:00:00.000Z',
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

export const runsFixture: AdminRunsResponse = {
  runs: [
    {
      id: 'run-1',
      workspaceId: 'ws-1',
      workspaceName: 'Acme Corp',
      repoFullName: 'acme/backend',
      pullNumber: 42,
      status: 'completed',
      costUsd: 0.15,
      createdAt: '2026-10-10T10:00:00.000Z',
      finishedAt: '2026-10-10T10:01:00.000Z',
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

export function renderWithProviders(
  element: ReactElement,
  { path = '/admin', language = 'en' as Language } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage={language}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<p>home page</p>} />
              <Route path={path} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

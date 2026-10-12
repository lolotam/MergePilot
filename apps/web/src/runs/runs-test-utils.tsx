import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Settings } from '@mergepilot/app/contract';
import * as hooks from '../api/hooks.js';
import type { ReviewRun, RunGroup } from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { I18nProvider } from '../i18n/context.js';
import { RunsPage } from '../pages/RunsPage.js';

// Test-only helpers for the runs page tests (the caller mocks '../api/hooks.js' and fetchApi).

export type Role = 'owner' | 'admin' | 'member';

let seq = 0;
export function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  seq += 1;
  return {
    id: `run-${seq}`,
    repoFullName: 'acme/backend',
    pullNumber: 1,
    headSha: `sha${seq}abcdef`,
    status: 'completed',
    costUsd: 0.01,
    detail: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    finishedAt: '2026-10-15T10:01:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    findingsCount: 0,
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  };
}

/** A PR group from its runs (newest first), with sums like the server's. */
export function makeGroup(runs: ReviewRun[]): RunGroup {
  const sum = (pick: (r: ReviewRun) => number | null | undefined) => {
    const values = runs.map(pick).filter((v): v is number => typeof v === 'number');
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {
    repoFullName: runs[0]!.repoFullName,
    pullNumber: runs[0]!.pullNumber,
    runCount: runs.length,
    costUsd: sum((r) => r.costUsd),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    runs,
  };
}

export interface RenderRunsOptions {
  url?: string | undefined;
  role?: Role;
  groups: RunGroup[];
  total?: number;
  totalRuns?: number;
  settings?: Partial<Settings> | null;
}

export const baseSettings: Settings = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  language: 'en',
  monthlyBudgetUsd: null,
  fallback: [],
  minSeverity: 'medium',
  runRetentionDays: 30,
  repoColors: {},
};

export function renderRunsPage(options: RenderRunsOptions) {
  const role = options.role ?? 'admin';
  vi.mocked(hooks.useMeQuery).mockReturnValue({
    data: {
      user: { id: 'u1', email: 'user@test.com', name: 'User', image: null, githubLinked: true },
      workspaces: [{ id: 'ws-1', name: 'WS 1', slug: 'ws-1', role }],
    },
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useMeQuery>);
  vi.mocked(hooks.useRunReposQuery).mockReturnValue({
    data: { repos: [...new Set(options.groups.map((g) => g.repoFullName))] },
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useRunReposQuery>);
  vi.mocked(hooks.useRunGroupsQuery).mockReturnValue({
    data: {
      groups: options.groups,
      total: options.total ?? options.groups.length,
      totalRuns: options.totalRuns ?? options.groups.reduce((n, g) => n + g.runs.length, 0),
    },
    isLoading: false,
  } as unknown as ReturnType<typeof hooks.useRunGroupsQuery>);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // The page reads repo colors from the settings cache; seed it so nothing is fetched on mount.
  queryClient.setQueryData(['workspaces', 'ws-1', 'settings'], {
    settings: options.settings === null ? null : { ...baseSettings, ...options.settings },
  });

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <ToastProvider>
          <MemoryRouter initialEntries={[options.url ?? '/w/ws-1/runs']}>
            <Routes>
              <Route path="/w/:workspaceId/runs" element={<RunsPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

/**
 * Makes the mocked fetchApi answer GET/PUT settings like the server (PUT merges the body), so a
 * refetch after a save returns what was saved. Other calls resolve to `{}`.
 */
export function fakeSettingsServer(fetchApi: (path: string, init?: RequestInit) => Promise<unknown>, initial: Partial<Settings> = {}) {
  let state: Settings = { ...baseSettings, ...initial };
  vi.mocked(fetchApi).mockImplementation(async (path: string, init?: RequestInit) => {
    if (!path.endsWith('/settings')) return {};
    if (init?.method === 'PUT') state = { ...state, ...(JSON.parse(String(init.body)) as Partial<Settings>) };
    return { settings: state };
  });
  return () => state;
}

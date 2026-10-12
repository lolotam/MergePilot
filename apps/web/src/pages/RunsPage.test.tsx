import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunsPage } from './RunsPage.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';
import * as hooks from '../api/hooks.js';
import * as client from '../api/client.js';
import type { ReviewRun } from '../api/client.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual('../api/client.js');
  return {
    ...actual,
    fetchApi: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('RunsPage - table columns, row navigation, filters and sorting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleRuns: ReviewRun[] = [
    {
      id: 'run-1',
      repoFullName: 'acme/backend',
      pullNumber: 42,
      headSha: 'abc1234',
      status: 'completed',
      costUsd: 0.0456,
      detail: null,
      createdAt: '2026-10-15T10:00:00.000Z',
      finishedAt: '2026-10-15T10:01:00.000Z',
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      effort: 'high',
      fallbackFrom: 'claude-3-5-sonnet',
      findingsCount: 3,
      severityCounts: {
        critical: 1,
        high: 1,
        medium: 1,
        low: 0,
        info: 0,
      },
      reviewUrl: 'https://github.com/acme/backend/pull/42#pullrequestreview-1',
    },
    {
      id: 'run-2',
      repoFullName: 'acme/frontend',
      pullNumber: 15,
      headSha: 'def5678',
      status: 'failed',
      costUsd: null,
      detail: 'quota',
      createdAt: '2026-10-15T11:00:00.000Z',
      finishedAt: '2026-10-15T11:00:10.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      findingsCount: 0,
    },
    {
      id: 'run-3',
      repoFullName: 'acme/mobile',
      pullNumber: 7,
      headSha: '789abcd',
      status: 'completed',
      costUsd: 0.012,
      detail: null,
      createdAt: '2026-10-15T12:00:00.000Z',
      finishedAt: '2026-10-15T12:00:30.000Z',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      findingsCount: 0,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
  ];

  const renderComponent = (
    initialEntries = ['/w/ws-1/runs'],
    role: 'owner' | 'admin' | 'member' = 'admin',
  ) => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'user@test.com', name: 'User', image: null, githubLinked: true },
        workspaces: [{ id: 'ws-1', name: 'WS 1', slug: 'ws-1', role }],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    vi.mocked(hooks.useRunReposQuery).mockReturnValue({
      data: { repos: ['acme/backend', 'acme/frontend', 'acme/mobile'] },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRunReposQuery>);

    vi.mocked(hooks.useRunsQuery).mockReturnValue({
      data: { runs: sampleRuns, total: 3 },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRunsQuery>);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    return render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLanguage="en">
          <ToastProvider>
            <MemoryRouter initialEntries={initialEntries}>
              <Routes>
                <Route path="/w/:workspaceId/runs" element={<RunsPage />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  };

  it('renders table columns including Provider, Model, and Result chips', () => {
    renderComponent();

    // Headers
    expect(screen.getByText('Provider')).toBeDefined();
    expect(screen.getByText('Model')).toBeDefined();
    expect(screen.getByText('Result')).toBeDefined();

    // Provider badges
    expect(screen.getByText('Anthropic')).toBeDefined();
    expect(screen.getByText('OpenAI')).toBeDefined();
    expect(screen.getByText('Gemini')).toBeDefined();

    // Model and effort
    expect(screen.getByText('claude-3-7-sonnet')).toBeDefined();
    expect(screen.getByText('high')).toBeDefined();
    expect(screen.getByText('Fallback')).toBeDefined();

    // Result severity chips
    expect(screen.getByText(/1 Critical/)).toBeDefined();
    expect(screen.getByText(/1 High/)).toBeDefined();
    expect(screen.getByText(/1 Medium/)).toBeDefined();

    // Failed error mapping
    expect(screen.getByText('Quota or budget exceeded')).toBeDefined();

    // No findings badge
    expect(screen.getByText('No findings')).toBeDefined();
  });

  it('navigates to run detail on row click and keyboard enter', () => {
    renderComponent();

    const row = screen.getByText('acme/backend').closest('tr');
    expect(row).not.toBeNull();

    // Click row
    fireEvent.click(row!);
    expect(mockNavigate).toHaveBeenCalledWith('/w/ws-1/runs/run-1');

    // Keyboard Enter
    fireEvent.keyDown(row!, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/w/ws-1/runs/run-1');
  });

  it('clicking GitHub PR link stops propagation and does not navigate to run detail', () => {
    renderComponent();

    const prLink = screen.getByText('#42');
    fireEvent.click(prLink);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('supports sorting columns with aria-sort toggle', () => {
    renderComponent();

    const modelHeader = screen.getByText('Model').closest('th');
    expect(modelHeader?.getAttribute('aria-sort')).toBe('none');

    const modelButton = screen.getByText('Model');
    fireEvent.click(modelButton);

    // Click triggers params update for sorting
    expect(hooks.useRunsQuery).toHaveBeenCalled();
  });

  it('renders filter bar with search, repo, and status dropdowns', () => {
    renderComponent();

    expect(screen.getByPlaceholderText('Search by repo, PR #, model...')).toBeDefined();
    expect(screen.getByText('Repositories')).toBeDefined();
    expect(screen.getAllByText('Status').length).toBeGreaterThanOrEqual(1);
  });

  it('renders Actions column with Retry button for failed runs and disabled for members', () => {
    renderComponent(['/w/ws-1/runs'], 'member');

    expect(screen.getByText('Actions')).toBeDefined();

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons.length).toBe(1);
    const memberRetryBtn = retryButtons[0]!;
    expect(memberRetryBtn.hasAttribute('disabled')).toBe(true);
    expect(memberRetryBtn.getAttribute('title')).toBe('Retrying requires admin or owner role');
  });

  it('admin can click Retry on a failed row to trigger retry and not navigate', async () => {
    vi.mocked(client.fetchApi).mockResolvedValueOnce({ runId: 'run-new-999' });
    renderComponent(['/w/ws-1/runs'], 'admin');

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons.length).toBe(1);
    const adminRetryBtn = retryButtons[0]!;
    expect(adminRetryBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(adminRetryBtn);
    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/runs/run-2/retry', {
        method: 'POST',
      });
    });
  });

  it('shows Retry all failed button for admin, opens confirm dialog, and triggers retry-failed', async () => {
    vi.mocked(client.fetchApi).mockResolvedValueOnce({ queued: 1, skipped: [] });
    renderComponent(['/w/ws-1/runs'], 'admin');

    const retryAllBtn = screen.getByRole('button', { name: 'Retry all failed' });
    expect(retryAllBtn).toBeDefined();

    fireEvent.click(retryAllBtn);

    expect(screen.getByText(/Are you sure you want to retry 1 failed review runs\?/)).toBeDefined();

    const dialogConfirmBtn = screen.getAllByRole('button', { name: 'Retry all failed' }).find(
      (b) => b.closest('[role="dialog"]') !== null,
    );
    expect(dialogConfirmBtn).toBeDefined();

    fireEvent.click(dialogConfirmBtn!);
    await waitFor(() => {
      expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/runs/retry-failed', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    });
  });

  it('does not render Retry all failed button for members', () => {
    renderComponent(['/w/ws-1/runs'], 'member');

    expect(screen.queryByRole('button', { name: 'Retry all failed' })).toBeNull();
  });

  it('can cancel the Retry all failed confirm dialog without calling API', () => {
    renderComponent(['/w/ws-1/runs'], 'admin');

    fireEvent.click(screen.getByRole('button', { name: 'Retry all failed' }));
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.fetchApi).not.toHaveBeenCalled();
  });
});

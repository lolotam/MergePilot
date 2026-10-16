import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import RunDetailPage from './RunDetailPage.js';
import { I18nProvider } from '../i18n/context.js';
import * as hooks from '../api/hooks.js';
import type { ReviewRun, ReviewRunResult } from '../api/client.js';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../components/Toast.js';
import * as client from '../api/client.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual('../api/client.js');
  return {
    ...actual,
    fetchApi: vi.fn(),
  };
});

describe('RunDetailPage - header, grouped findings, plain text rendering, filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleResult: ReviewRunResult = {
    v: 1,
    summary: 'This pull request refactors the database layer.',
    highlights: ['Refactored pg-store', 'Added query optimization', 'Fixed memory leak'],
    findings: [
      {
        path: 'src/db/store.ts',
        line: 42,
        endLine: 45,
        severity: 'critical',
        category: 'security',
        title: 'SQL Injection Vulnerability',
        body: 'User input is interpolated directly without parameterization:\n<img src="x" onerror="alert(\'xss\')">',
        suggestion: 'await db.query(sql`SELECT * FROM users WHERE id = ${id}`);',
      },
      {
        path: 'src/db/helper.ts',
        line: 12,
        severity: 'medium',
        title: 'Unused Variable',
        body: 'Variable is declared but never read.',
      },
      {
        path: 'src/api/routes.ts',
        line: 105,
        severity: 'low',
        title: 'Missing return type',
        body: 'Explicit return type annotation recommended.',
      },
    ],
    outOfDiff: [
      {
        path: 'src/legacy/old.ts',
        line: 88,
        severity: 'high',
        title: 'Deprecated API usage',
        body: 'Calling deprecated crypto method.',
      },
    ],
    language: 'en',
    usage: {
      inputTokens: 1250,
      outputTokens: 420,
    },
    verify: {
      dropped: 2,
    },
  };

  const sampleRun: ReviewRun & { result?: ReviewRunResult | null } = {
    id: 'run-123',
    repoFullName: 'org/repo',
    pullNumber: 99,
    headSha: 'c0ffee1',
    status: 'completed',
    costUsd: 0.0892,
    detail: null,
    createdAt: '2026-10-15T12:00:00.000Z',
    finishedAt: '2026-10-15T12:01:15.000Z',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    fallbackFrom: 'claude-3-5-sonnet',
    findingsCount: 3,
    reviewUrl: 'https://github.com/org/repo/pull/99#pullrequestreview-456',
    result: sampleResult,
  };

  const renderComponent = (runData = sampleRun, role: 'owner' | 'admin' | 'member' = 'admin') => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'user@test.com', name: 'User', image: null, githubLinked: true },
        workspaces: [{ id: 'ws-1', name: 'WS 1', slug: 'ws-1', role }],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    vi.mocked(hooks.useRunDetailQuery).mockReturnValue({
      data: { run: runData },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRunDetailQuery>);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    return render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLanguage="en">
          <ToastProvider>
            <MemoryRouter initialEntries={['/w/ws-1/runs/run-123']}>
              <Routes>
                <Route path="/w/:workspaceId/runs/:runId" element={<RunDetailPage />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  };

  it('shows the method-fallback notice when the run result discloses a method switch', () => {
    const runWithMethod = {
      ...sampleRun,
      result: {
        ...sampleResult,
        fallbackFromMethod: 'subscription' as const,
        modelUsedMethod: 'api-key' as const,
      },
    };
    const { getByTestId } = renderComponent(runWithMethod);
    expect(getByTestId('method-fallback-notice').textContent).toMatch(/API key/i);
  });

  it('renders header metadata including repo, PR link, reviewUrl, model, tokens, and duration', () => {
    renderComponent();

    expect(screen.getByText('org/repo')).toBeDefined();
    expect(screen.getByText('#99')).toBeDefined();
    expect(screen.getByText('Anthropic')).toBeDefined();
    expect(screen.getByText('claude-3-7-sonnet')).toBeDefined();
    expect(screen.getAllByText('high').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Fallback')).toBeDefined();
    expect(screen.getByText('$0.0892')).toBeDefined();
    expect(screen.getByText('1,250 in / 420 out')).toBeDefined();
    expect(screen.getByText('1m 15s')).toBeDefined();

    const reviewLink = screen.getByText('Open review on GitHub').closest('a');
    expect(reviewLink?.getAttribute('href')).toBe(
      'https://github.com/org/repo/pull/99#pullrequestreview-456',
    );
  });

  it('renders summary bullets and highlights as plain text', () => {
    renderComponent();

    expect(screen.getByText('This pull request refactors the database layer.')).toBeDefined();
    expect(screen.getByText('Refactored pg-store')).toBeDefined();
    expect(screen.getByText('Added query optimization')).toBeDefined();
    expect(screen.getByText('Fixed memory leak')).toBeDefined();
    expect(screen.getByText(/Dropped 2 noisy findings/)).toBeDefined();
  });

  it('groups findings by directory -> file with counts and collapsible headers', () => {
    renderComponent();

    // Directories
    expect(screen.getByText('src/db')).toBeDefined();
    expect(screen.getByText('src/api')).toBeDefined();

    // Files
    expect(screen.getByText('store.ts')).toBeDefined();
    expect(screen.getByText('helper.ts')).toBeDefined();
    expect(screen.getByText('routes.ts')).toBeDefined();

    // Out of diff section
    expect(screen.getByText('Out-of-diff Findings')).toBeDefined();
    expect(screen.getByText('src/legacy/old.ts')).toBeDefined();
  });

  it('renders finding body as plain text without HTML injection from <img onerror>', () => {
    const { container } = renderComponent();

    // HTML tag is rendered as literal text content, not executable DOM element
    const imgElement = container.querySelector('img[onerror]');
    expect(imgElement).toBeNull();

    expect(
      screen.getByText(/User input is interpolated directly without parameterization/),
    ).toBeDefined();
  });

  it('filters findings by severity dropdown', () => {
    renderComponent();

    expect(screen.getByText('SQL Injection Vulnerability')).toBeDefined();
    expect(screen.getByText('Unused Variable')).toBeDefined();

    // Select 'critical'
    const select = screen.getByLabelText('Filter by severity');
    fireEvent.change(select, { target: { value: 'critical' } });

    expect(screen.getByText('SQL Injection Vulnerability')).toBeDefined();
    expect(screen.queryByText('Unused Variable')).toBeNull();
  });

  it('renders failed run state when status is failed', () => {
    const failedRun = {
      ...sampleRun,
      status: 'failed' as const,
      detail: 'Rate limit exceeded on provider API',
      result: null,
    };
    renderComponent(failedRun);
    expect(screen.getByText('Rate limit exceeded on provider API')).toBeDefined();
  });

  it('renders enabled Retry button for failed runs when user is admin or owner, and triggers mutation on click', async () => {
    vi.mocked(client.fetchApi).mockResolvedValueOnce({ runId: 'run-retry-new' });

    const failedRun = {
      ...sampleRun,
      status: 'failed' as const,
      detail: 'Rate limit exceeded',
      result: null,
    };
    renderComponent(failedRun, 'admin');

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toBeDefined();
    expect(retryButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/runs/run-123/retry', {
        method: 'POST',
      });
    });
  });

  it('renders disabled Retry button with tooltip for members on failed runs', () => {
    const failedRun = {
      ...sampleRun,
      status: 'failed' as const,
      detail: 'Rate limit exceeded',
      result: null,
    };
    renderComponent(failedRun, 'member');

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    expect(retryButton).toBeDefined();
    expect(retryButton.hasAttribute('disabled')).toBe(true);
    expect(retryButton.getAttribute('title')).toBe('Retrying requires admin or owner role');
  });

  it('does not render Retry button for completed runs', () => {
    renderComponent(sampleRun, 'admin');

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows the bot that ran the review next to its model', () => {
    renderComponent({ ...sampleRun, botSlot: 3, botName: 'Fox bot' });
    expect(screen.getByTestId('run-bot-chip').textContent).toContain('Fox bot');
    expect(screen.getByTitle('Bot: Fox bot')).toBeDefined();
  });
});

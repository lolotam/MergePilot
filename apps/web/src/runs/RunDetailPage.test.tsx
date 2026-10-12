import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import RunDetailPage from './RunDetailPage.js';
import { I18nProvider } from '../i18n/context.js';
import * as hooks from '../api/hooks.js';
import type { ReviewRun, ReviewRunResult } from '../api/client.js';

vi.mock('../api/hooks.js');

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

  const renderComponent = (runData = sampleRun) => {
    vi.mocked(hooks.useRunDetailQuery).mockReturnValue({
      data: { run: runData },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRunDetailQuery>);

    return render(
      <I18nProvider initialLanguage="en">
        <MemoryRouter initialEntries={['/w/ws-1/runs/run-123']}>
          <Routes>
            <Route path="/w/:workspaceId/runs/:runId" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
  };

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
});

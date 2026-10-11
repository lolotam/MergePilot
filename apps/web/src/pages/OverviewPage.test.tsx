import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { OverviewPage } from './OverviewPage.js';
import { I18nProvider } from '../i18n/context.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');

describe('OverviewPage - onboarding checklist states and usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setupMocks = ({
    installations = [] as Array<{ id: number }>,
    keys = [] as Array<{ provider: string }>,
    settings = null as { model: string; provider: string } | null,
    runs = [] as Array<{ id: string; repoFullName: string; pullNumber: number; status: string }>,
    usage = { monthCostUsd: 15, monthlyBudgetUsd: 100, monthStart: '2026-10-01' },
  } = {}) => {
    vi.mocked(hooks.useInstallationsQuery).mockReturnValue({
      data: { installations },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useInstallationsQuery>);

    vi.mocked(hooks.useKeysQuery).mockReturnValue({
      data: { keys },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useKeysQuery>);

    vi.mocked(hooks.useSettingsQuery).mockReturnValue({
      data: { settings },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useSettingsQuery>);

    vi.mocked(hooks.useRunsQuery).mockReturnValue({
      data: { runs },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useRunsQuery>);

    vi.mocked(hooks.useUsageQuery).mockReturnValue({
      data: usage,
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useUsageQuery>);
  };

  const renderComponent = () =>
    render(
      React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/w/ws-1'] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, { path: '/w/:workspaceId', element: React.createElement(OverviewPage, null) }),
          ),
        ),
      ),
    );

  it('renders onboarding checklist when items are missing', () => {
    setupMocks({
      installations: [],
      keys: [],
      settings: null,
    });

    renderComponent();

    // Checklist banner should be visible
    expect(screen.getByText(/خطوات البدء السريع/i)).toBeDefined();
    expect(screen.getByText(/١\. ربط حساب GitHub/i)).toBeDefined();
    expect(screen.getByText(/٢\. إضافة مفتاح API/i)).toBeDefined();
    expect(screen.getByText(/٣\. ضبط النموذج/i)).toBeDefined();
  });

  it('marks completed steps in onboarding checklist when partially configured', () => {
    setupMocks({
      installations: [{ id: 12345 }],
      keys: [],
      settings: null,
    });

    renderComponent();

    // Banner is still visible because keys and settings are missing
    expect(screen.getByText(/خطوات البدء السريع/i)).toBeDefined();
    // Step 1 completed indicator
    const completedBadges = screen.getAllByText(/مكتمل/i);
    expect(completedBadges.length).toBe(1);
  });

  it('hides onboarding checklist banner when all 3 steps are complete', () => {
    setupMocks({
      installations: [{ id: 12345 }],
      keys: [{ provider: 'anthropic' }],
      settings: { model: 'claude-3-7-sonnet', provider: 'anthropic' },
    });

    renderComponent();

    // Checklist banner should NOT be rendered
    expect(screen.queryByText(/خطوات البدء السريع/i)).toBeNull();
  });

  it('renders usage and budget progress bar', () => {
    setupMocks({
      usage: { monthCostUsd: 25.5, monthlyBudgetUsd: 50, monthStart: '2026-10-01' },
    });

    renderComponent();

    expect(screen.getByText(/\$25\.5/)).toBeDefined();
    expect(screen.getByText(/\$50/)).toBeDefined();
  });
});

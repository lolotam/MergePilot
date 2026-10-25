import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiEquivalentCard } from './ApiEquivalentCard.js';
import { I18nProvider } from '../i18n/context.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');

function answer(data: object | undefined, isError = false) {
  vi.mocked(hooks.useApiEquivalentUsageQuery).mockReturnValue({
    data, isLoading: false, isError,
  } as unknown as ReturnType<typeof hooks.useApiEquivalentUsageQuery>);
  render(<I18nProvider initialLanguage="en"><ApiEquivalentCard workspaceId="ws-1" /></I18nProvider>);
}

describe('ApiEquivalentCard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the month, average and a by-model row from the API answer', () => {
    answer({
      monthUsd: 12.34, totalUsd: 30, reviews: 4, averagePerReviewUsd: 7.5, leftOut: 0,
      byModel: [{ provider: 'openai', model: 'gpt-x', inputTokens: 1000, outputTokens: 200, usd: 12.34 }],
      monthStart: '2026-10-01T00:00:00.000Z',
    });
    expect(screen.getByText('≈ $12.34')).toBeTruthy();
    expect(screen.getByText('$7.50')).toBeTruthy();
    expect(screen.getByText('openai / gpt-x')).toBeTruthy();
    expect(screen.getByText('1,000 in / 200 out')).toBeTruthy();
  });

  it('renders the empty state', () => {
    answer({ monthUsd: 0, totalUsd: 0, reviews: 0, averagePerReviewUsd: 0, leftOut: 0, byModel: [], monthStart: '2026-10-01' });
    expect(screen.getByText('No subscription or coding-plan usage yet.')).toBeTruthy();
  });

  it('shows runs left out instead of the empty state when none could be priced', () => {
    answer({ monthUsd: 0, totalUsd: 0, reviews: 0, averagePerReviewUsd: 0, leftOut: 3, byModel: [], monthStart: '2026-10-01' });
    expect(screen.queryByText('No subscription or coding-plan usage yet.')).toBeNull();
    expect(screen.getByText('≈ $0.00')).toBeTruthy();
  });

  it('keeps the last totals when a background refetch fails', () => {
    answer({ monthUsd: 12.34, totalUsd: 30, reviews: 4, averagePerReviewUsd: 7.5, leftOut: 0, byModel: [], monthStart: '2026-10-01' }, true);
    expect(screen.getByText('≈ $12.34')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error, not the empty state, when the request fails', () => {
    answer(undefined, true);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No subscription or coding-plan usage yet.')).toBeNull();
  });
});

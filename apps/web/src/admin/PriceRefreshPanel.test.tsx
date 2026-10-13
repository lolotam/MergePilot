import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { adminApi } from '../api/admin.js';
import { ApiClientError } from '../api/client.js';
import { renderWithProviders } from './admin-test-utils.js';
import { PriceRefreshPanel } from './PriceRefreshPanel.js';

vi.mock('../api/admin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/admin.js')>()),
  adminApi: { getMaintenance: vi.fn(), runRetention: vi.fn(), refreshPrices: vi.fn() },
}));

const finished = {
  id: 'p-1',
  startedAt: '2026-10-13T02:30:00.000Z',
  finishedAt: '2026-10-13T02:30:09.000Z',
  deletedCount: 2345,
  error: null,
};

describe('admin overview: model price refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the last refresh with the number of prices stored, and its error when there was one', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({
      retention: { lastRun: null },
      prices: { lastRun: { ...finished, error: 'vercel: timeout' } },
    });
    renderWithProviders(<PriceRefreshPanel />);
    expect(await screen.findByText('2,345 prices stored')).toBeTruthy();
    expect(screen.getByText(/Oct 13, 2026/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Error: vercel: timeout');
  });

  it('"Refresh prices now" calls the admin route and then shows it running', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: null } });
    vi.mocked(adminApi.refreshPrices).mockResolvedValue({ runId: 'p-2' });
    renderWithProviders(<PriceRefreshPanel />);
    expect(await screen.findByText('Has not run yet')).toBeTruthy();

    vi.mocked(adminApi.getMaintenance).mockResolvedValue({
      retention: { lastRun: null },
      prices: { lastRun: { ...finished, finishedAt: null } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh prices now' }));
    await waitFor(() => expect(adminApi.refreshPrices).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Price refresh started')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('prices-status').textContent).toBe('Refreshing now…'));
    expect(screen.getByRole('button', { name: 'Refresh prices now' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains when a refresh is already running', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: null }, prices: { lastRun: finished } });
    vi.mocked(adminApi.refreshPrices).mockRejectedValue(new ApiClientError('busy', 'already_running', 409));
    renderWithProviders(<PriceRefreshPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh prices now' }));
    expect(await screen.findByText('A price refresh is already running')).toBeTruthy();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { adminApi } from '../api/admin.js';
import { ApiClientError } from '../api/client.js';
import { renderWithProviders } from './admin-test-utils.js';
import { RetentionPanel } from './RetentionPanel.js';

vi.mock('../api/admin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/admin.js')>()),
  adminApi: { getMaintenance: vi.fn(), runRetention: vi.fn() },
}));

const finished = {
  id: 'm-1',
  startedAt: '2026-10-12T03:00:00.000Z',
  finishedAt: '2026-10-12T03:00:04.000Z',
  deletedCount: 1234,
  error: null,
};

describe('admin overview: review history cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the last run with its deleted count, and its error when there was one', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({
      retention: { lastRun: { ...finished, error: 'Error: deadlock detected' } },
    });
    renderWithProviders(<RetentionPanel />);
    expect(await screen.findByText('1,234 records deleted')).toBeTruthy();
    expect(screen.getByText(/Oct 12, 2026/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Error: Error: deadlock detected');
  });

  it('says when it never ran, and "Run now" starts a cleanup', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: null } });
    vi.mocked(adminApi.runRetention).mockResolvedValue({ runId: 'm-2' });
    renderWithProviders(<RetentionPanel />);
    expect(await screen.findByText('Has not run yet')).toBeTruthy();

    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: { ...finished, finishedAt: null } } });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Cleanup started')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('retention-status').textContent).toBe('Running now…'));
    expect(screen.getByRole('button', { name: 'Run now' }).hasAttribute('disabled')).toBe(true);
  });

  it('explains when a cleanup is already running', async () => {
    vi.mocked(adminApi.getMaintenance).mockResolvedValue({ retention: { lastRun: finished } });
    vi.mocked(adminApi.runRetention).mockRejectedValue(new ApiClientError('busy', 'already_running', 409));
    renderWithProviders(<RetentionPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('A cleanup is already running')).toBeTruthy();
  });
});

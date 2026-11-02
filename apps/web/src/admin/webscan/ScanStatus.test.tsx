import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../admin-test-utils.js';
import { ScanStatus } from './ScanStatus.js';
import { scanFixture } from './webscan-test-utils.js';

/**
 * The counters of a scan.
 *
 * The counters of the stream are the fresh view of a scan that runs. A scan
 * that ended has its durable counters from the server: a stream that dropped
 * in the gap between the last progress and the end of the scan would
 * otherwise leave the numbers of that moment next to the final state.
 */
describe('the state of a scan', () => {
  it('shows the durable counters of a scan that ended', () => {
    renderWithProviders(
      <ScanStatus
        scan={{
          ...scanFixture,
          status: 'completed',
          requests: 120,
          pages: 30,
          durationMs: 60000,
        }}
        progress={{ status: 'running', requests: 42, pages: 9, elapsedMs: 12000 }}
      />,
    );

    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
    expect(screen.queryByText('9')).toBeNull();
    expect(screen.queryByText('12')).toBeNull();
  });

  it('shows the live counters of a scan that runs', () => {
    renderWithProviders(
      <ScanStatus
        scan={scanFixture}
        progress={{ status: 'running', requests: 42, pages: 9, elapsedMs: 12000 }}
      />,
    );

    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import * as client from '../api/client.js';
import * as hooks from '../api/hooks.js';
import { makeGroup, makeRun, renderRunsPage } from '../runs/runs-test-utils.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));
vi.mock('react-router', async () => ({ ...(await vi.importActual('react-router')), useNavigate: () => vi.fn() }));

const CREATED = '2026-10-15T10:00:00.000Z';
const durationCells = () => screen.getAllByTestId('run-duration').map((c) => c.textContent);

describe('RunsPage duration column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.fetchApi).mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sits after Tokens out and before Cost, and sorts on the server by `duration`', () => {
    renderRunsPage({ groups: [makeGroup([makeRun({ durationMs: 45_000 })])] });
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const at = headers.indexOf('Duration');
    expect(headers.slice(at - 1, at + 2)).toEqual(['Tokens out', 'Duration', 'Cost']);

    fireEvent.click(screen.getByRole('button', { name: 'Duration' }));
    const lastCall = vi.mocked(hooks.useRunGroupsQuery).mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ sort: 'duration' });
    expect(screen.getByRole('columnheader', { name: 'Duration' }).getAttribute('aria-sort')).not.toBe('none');
  });

  it('shows finished durations and "—" when unknown', () => {
    renderRunsPage({
      groups: [
        makeGroup([makeRun({ pullNumber: 1, durationMs: 45_000 })]),
        makeGroup([makeRun({ pullNumber: 2, durationMs: 3 * 60_000 + 12_000 })]),
        makeGroup([makeRun({ pullNumber: 3, durationMs: 3_840_000 })]),
        makeGroup([makeRun({ pullNumber: 4, durationMs: null })]),
      ],
    });
    expect(durationCells()).toEqual(['45s', '3m 12s', '1h 04m', '—']);
    expect(screen.queryByTestId('run-duration-live')).toBeNull();
  });

  it('the PR row shows its latest run duration (not a sum); sub-rows show their own', () => {
    const group = makeGroup([
      makeRun({ id: 'new', pullNumber: 7, durationMs: 30_000 }),
      makeRun({ id: 'old', pullNumber: 7, status: 'failed', durationMs: 600_000 }),
    ]);
    renderRunsPage({ groups: [group] });
    expect(within(screen.getByTestId('run-group-row')).getByTestId('run-duration').textContent).toBe('30s');

    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#7' }));
    const subs = screen.getAllByTestId('run-sub-row').map((r) => within(r).getByTestId('run-duration').textContent);
    expect(subs).toEqual(['30s', '10m 00s']);
  });

  it('a running or queued row shows a live timer that ticks every second', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date(Date.parse(CREATED) + 65_000));
    renderRunsPage({
      groups: [
        makeGroup([makeRun({ pullNumber: 1, status: 'running', createdAt: CREATED, finishedAt: null, durationMs: null })]),
        makeGroup([makeRun({ pullNumber: 2, status: 'queued', createdAt: CREATED, finishedAt: null, durationMs: null })]),
      ],
    });
    const live = () => screen.getAllByTestId('run-duration-live').map((c) => c.textContent);
    expect(live()).toEqual(['1m 05s', '1m 05s']);
    expect(screen.getAllByTestId('run-duration-live')[0]!.getAttribute('title')).toMatch(/Still running/);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(live()).toEqual(['1m 08s', '1m 08s']);
  });

  it('runs no timer when no visible row is active (a running run inside a collapsed PR)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const group = makeGroup([
      makeRun({ pullNumber: 7, durationMs: 20_000 }),
      makeRun({ pullNumber: 7, status: 'running', finishedAt: null, durationMs: null }),
    ]);
    renderRunsPage({ groups: [group] });
    expect(vi.getTimerCount()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#7' }));
    expect(screen.getAllByTestId('run-duration-live')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Hide the runs of acme/backend#7' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import * as client from '../api/client.js';
import { LIVE_DEBOUNCE_MS } from '../api/useRunsLive.js';
import { makeGroup, makeRun, renderRunsPage } from './runs-test-utils.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));
vi.mock('react-router', async () => ({ ...(await vi.importActual('react-router')), useNavigate: () => vi.fn() }));

class StubEventSource {
  static readonly CLOSED = 2;
  static last: StubEventSource | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly runListeners: Array<(e: MessageEvent<string>) => void> = [];
  constructor(readonly url: string) {
    StubEventSource.last = this;
  }
  addEventListener(_type: string, listener: (e: MessageEvent<string>) => void) {
    this.runListeners.push(listener);
  }
  close() {
    this.readyState = 2;
  }
}

describe('runs page live updates (ADR-0021)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.fetchApi).mockResolvedValue({});
    vi.stubGlobal('EventSource', StubEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the Live indicator once the stream opens and refetches the runs on an event', () => {
    vi.useFakeTimers();
    const { queryClient } = renderRunsPage({ groups: [makeGroup([makeRun({ id: 'a' })])] });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const source = StubEventSource.last!;
    expect(source.url).toBe('/api/workspaces/ws-1/runs/events');
    expect(screen.getByTestId('live-indicator').getAttribute('data-state')).toBe('connecting');

    act(() => source.onopen?.());
    expect(screen.getByTestId('live-indicator').textContent).toBe('Live');

    act(() => {
      for (const l of source.runListeners) l(new MessageEvent('run', { data: '{"runId":"b","status":"queued","kind":"created"}' }));
      vi.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces', 'ws-1', 'runs'] });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { LIVE_DEBOUNCE_MS, LIVE_RECONCILE_MS, useRunsLive } from './useRunsLive.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Array<(m: MessageEvent<string>) => void> = [];
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(_type: string, l: (m: MessageEvent<string>) => void) { this.listeners.push(l); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; act(() => this.onopen?.()); }
  fail() { act(() => this.onerror?.()); }
  emit() { for (const l of this.listeners) l({ data: '{"runId":"r","status":"queued","kind":"created"}' } as MessageEvent<string>); }
}
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

describe('useRunsLive follow-ups', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconciles with a light refetch every two minutes while live, and stops when the stream drops', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => React.createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => useRunsLive('ws-1'), { wrapper });
    latest().open();
    invalidate.mockClear();

    act(() => vi.advanceTimersByTime(LIVE_RECONCILE_MS));
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Drop the stream 10 s before the next reconcile tick: that tick must not happen (the
    // fallback polling only starts 30 s after the drop).
    act(() => vi.advanceTimersByTime(LIVE_RECONCILE_MS - 10_000));
    latest().fail();
    invalidate.mockClear();
    act(() => vi.advanceTimersByTime(20_000));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refetches once more after a restarted first load that an event arrived during', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const resolvers: Array<(v: string[]) => void> = [];
    const queryFn = vi.fn(() => new Promise<string[]>((resolve) => resolvers.push(resolve)));
    const wrapper = ({ children }: { children: ReactNode }) => React.createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => {
      useQuery({ queryKey: ['workspaces', 'ws-1', 'runs', 'list'], queryFn });
      return useRunsLive('ws-1');
    }, { wrapper });
    await act(async () => { await Promise.resolve(); });
    expect(queryFn).toHaveBeenCalledTimes(1);

    latest().open(); // the catch-up restarts the slow first load once
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(queryFn).toHaveBeenCalledTimes(2);

    latest().emit(); // an event while the restarted load is still in flight
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS); });
    expect(queryFn).toHaveBeenCalledTimes(2);

    await act(async () => { resolvers[1]!([]); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(queryFn).toHaveBeenCalledTimes(3);
  });
});

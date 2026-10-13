import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactNode } from 'react';
import { I18nProvider } from '../i18n/context.js';
import { LiveIndicator } from '../runs/LiveIndicator.js';
import {
  LIVE_DEBOUNCE_MS, LIVE_DOWN_FALLBACK_MS, LIVE_FALLBACK_POLL_MS, runEventsUrl, useRunsLive, type LiveState,
} from './useRunsLive.js';

/** A stand-in for the browser's EventSource (jsdom has none). */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    act(() => this.onopen?.());
  }

  fail(closed = false) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    act(() => this.onerror?.());
  }

  emitRun(data: object) {
    const event = new MessageEvent('run', { data: JSON.stringify(data) });
    for (const l of this.listeners.get('run') ?? []) l(event);
  }
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

function setup(runId?: string) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useRunsLive('ws-1', runId ? { runId } : {}), { wrapper });
  return { invalidate, hook };
}

describe('useRunsLive (ADR-0021)', () => {
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

  it('opens the workspace stream and reports live once it is open', () => {
    const { hook } = setup();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe(runEventsUrl('ws-1'));
    expect(latest().url).toBe('/api/workspaces/ws-1/runs/events');
    expect(hook.result.current).toBe('connecting');

    latest().open();
    expect(hook.result.current).toBe('live');
  });

  it('catches up with one refetch on every open, including the first', () => {
    const { invalidate } = setup();
    latest().open();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces', 'ws-1', 'runs'] });
  });

  it('invalidates the runs queries once per burst of events, after the debounce', () => {
    const { invalidate } = setup();
    latest().open();
    invalidate.mockClear();

    latest().emitRun({ runId: 'a', status: 'queued', kind: 'created' });
    latest().emitRun({ runId: 'b', status: 'running', kind: 'created' });
    act(() => vi.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(invalidate).toHaveBeenCalledTimes(1);
    // The prefix covers the list, the PR groups and the repos.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces', 'ws-1', 'runs'] });

    latest().emitRun({ runId: 'a', status: 'completed', kind: 'updated' });
    act(() => vi.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('starts polling every 30 s after the stream stays down for 30 s, and stops on reconnect', () => {
    const { invalidate, hook } = setup();
    latest().open();
    invalidate.mockClear();
    latest().fail();
    expect(hook.result.current).toBe('connecting');

    act(() => vi.advanceTimersByTime(LIVE_DOWN_FALLBACK_MS - 1));
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current).toBe('polling');
    expect(invalidate).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(LIVE_FALLBACK_POLL_MS));
    expect(invalidate).toHaveBeenCalledTimes(2);

    // The browser's own retry succeeds: back to live, one catch-up refetch, no more polling.
    latest().open();
    expect(hook.result.current).toBe('live');
    expect(invalidate).toHaveBeenCalledTimes(3);
    act(() => vi.advanceTimersByTime(LIVE_FALLBACK_POLL_MS * 3));
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('does not poll when the stream comes back within 30 s, but still catches up once', () => {
    const { invalidate, hook } = setup();
    latest().open();
    invalidate.mockClear();
    latest().fail();
    act(() => vi.advanceTimersByTime(LIVE_DOWN_FALLBACK_MS / 2));
    latest().open();
    act(() => vi.advanceTimersByTime(LIVE_DOWN_FALLBACK_MS * 2));
    // Events from the short outage are not replayed: the reconnect refetches once, then no polling.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBe('live');
  });

  it('opens a new stream 30 s after the browser gave up on one (e.g. a 503 answer)', () => {
    setup();
    const first = latest();
    first.fail(true);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(LIVE_FALLBACK_POLL_MS));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('on a run detail page refetches only that run, and only for its own events', () => {
    const { invalidate } = setup('run-9');
    latest().open();
    invalidate.mockClear();

    latest().emitRun({ runId: 'other', status: 'completed', kind: 'updated' });
    act(() => vi.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    expect(invalidate).not.toHaveBeenCalled();

    latest().emitRun({ runId: 'run-9', status: 'completed', kind: 'updated' });
    act(() => vi.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces', 'ws-1', 'runs', 'run-9'] });
  });

  it('closes the stream and its timers when the page unmounts', () => {
    const { invalidate, hook } = setup();
    const source = latest();
    source.open();
    invalidate.mockClear();
    source.emitRun({ runId: 'a', status: 'queued', kind: 'created' });
    hook.unmount();

    expect(source.closed).toBe(true);
    act(() => vi.advanceTimersByTime(LIVE_FALLBACK_POLL_MS * 2));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useRunsLive without EventSource', () => {
  it('stays off and starts no timer, leaving the page to its usual refetching', () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
      const { result } = renderHook(() => useRunsLive('ws-1'), { wrapper });
      expect(result.current).toBe('off');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LiveIndicator', () => {
  const renderIn = (language: 'ar' | 'en', state: LiveState) =>
    render(
      <I18nProvider initialLanguage={language}>
        <LiveIndicator state={state} />
      </I18nProvider>,
    );

  it('renders «Live» in English and «مباشر» in Arabic when connected', () => {
    const en = renderIn('en', 'live');
    expect(screen.getByTestId('live-indicator').textContent).toBe('Live');
    en.unmount();
    renderIn('ar', 'live');
    expect(screen.getByTestId('live-indicator').textContent).toBe('مباشر');
  });

  it('renders nothing when live updates are off', () => {
    renderIn('en', 'off');
    expect(screen.queryByTestId('live-indicator')).toBeNull();
  });

  it('says when it is polling instead', () => {
    renderIn('en', 'polling');
    expect(screen.getByTestId('live-indicator').getAttribute('data-state')).toBe('polling');
    expect(screen.getByTestId('live-indicator').textContent).toBe('Updating every 30s');
  });
});

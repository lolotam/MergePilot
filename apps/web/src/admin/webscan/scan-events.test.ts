import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { toScanProgress, useScanEvents } from './scan-events.js';
import { newScanIdempotencyKey } from './scan-intent.js';
import { FakeEventSource } from './webscan-test-utils.js';

describe('the live progress of a scan', () => {
  it('reads the counters of an event of the stream', () => {
    const progress = toScanProgress({
      scanId: 'scan-1',
      siteId: 'site-1',
      kind: 'progress',
      status: 'running',
      requests: 12,
      pages: 3,
      elapsedMs: 4000,
    });

    expect(progress).toEqual({ status: 'running', requests: 12, pages: 3, elapsedMs: 4000 });
  });

  it('ignores an event that carries nothing usable', () => {
    expect(toScanProgress(null)).toBeUndefined();
    expect(toScanProgress('progress')).toBeUndefined();
    expect(toScanProgress({ status: 'running' })).toBeUndefined();
    expect(toScanProgress({ status: 'unknown', requests: 1, pages: 1, elapsedMs: 1 })).toBeUndefined();
  });
});

describe('the idempotency key of a manual scan', () => {
  it('is long enough for the contract and different every time', () => {
    const first = newScanIdempotencyKey();
    const second = newScanIdempotencyKey();

    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).not.toBe(second);
  });
});

const originalEventSource = global.EventSource;

describe('the stream of a scan', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    global.EventSource = originalEventSource;
  });

  /** The progress of one event of the stream. */
  function progress(status: string, requests = 1) {
    return { scanId: 'scan-1', siteId: 'site-1', kind: 'progress', status, requests, pages: 1, elapsedMs: 10 };
  }

  /** The stream of one scan, with the calls the panel made because of it. */
  function listen() {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const onProgress = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    renderHook(() => useScanEvents('scan-1', onProgress), { wrapper });
    return { invalidate, onProgress, stream: FakeEventSource.instances[0] };
  }

  it('asks for the state of the scan again when the status of the stream changes', () => {
    const { invalidate, stream } = listen();

    act(() => {
      stream?.emit('scan', progress('running'));
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scan', 'scan-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scans'] });
    expect(invalidate).toHaveBeenCalledTimes(2);

    // The same status with new counters is a progress event, not a new state.
    act(() => {
      stream?.emit('scan', progress('running', 42));
    });
    expect(invalidate).toHaveBeenCalledTimes(2);

    // A finished scan is a state the server owns now.
    act(() => {
      stream?.emit('scan', progress('completed', 90));
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scan', 'scan-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scans'] });
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('refreshes the scan and its history when the stream opens or drops', () => {
    const { invalidate, stream } = listen();

    // A scan that finished while the stream was down shows in both views after a reconnect.
    act(() => {
      stream?.onopen?.();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scan', 'scan-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['webscan', 'scans'] });
    expect(invalidate).toHaveBeenCalledTimes(2);

    act(() => {
      stream?.onerror?.();
    });
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it('ignores an event that carries no usable progress', () => {
    const { invalidate, onProgress, stream } = listen();

    act(() => {
      stream?.emit('scan', { status: 'running' });
    });
    act(() => {
      stream?.emit('scan', { status: 'unknown', requests: 1, pages: 1, elapsedMs: 1 });
    });

    expect(onProgress).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    // The malformed events did not use the status of the stream up.
    act(() => {
      stream?.emit('scan', progress('running'));
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

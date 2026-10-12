import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { RUN_HEARTBEAT_INTERVAL_MS, startRunHeartbeat } from './run-heartbeat.js';

describe('startRunHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches the run every interval (60 s by default) until stopped', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const touch = vi.spyOn(store, 'touchReviewRun').mockResolvedValue();

    const stop = startRunHeartbeat(store, 'ws-1', 'run-1');
    expect(RUN_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(touch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith('ws-1', 'run-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(touch).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(touch).toHaveBeenCalledTimes(3);
  });

  it('logs only the error name when a touch fails, never its message', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const marker = ['conn', 'detail', 'x'.repeat(8)].join('-');
    vi.spyOn(store, 'touchReviewRun').mockRejectedValue(new TypeError(marker));
    const log = vi.fn();

    const stop = startRunHeartbeat(store, 'ws-1', 'run-1', { intervalMs: 1_000, log });
    await vi.advanceTimersByTimeAsync(1_000);
    stop();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('TypeError');
    expect(log.mock.calls[0]?.[0]).not.toContain(marker);
  });
});

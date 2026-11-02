import { describe, expect, it } from 'vitest';
import { toScanProgress } from './scan-events.js';
import { newScanIdempotencyKey } from './scan-intent.js';

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

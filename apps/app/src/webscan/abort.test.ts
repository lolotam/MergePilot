import { describe, expect, it } from 'vitest';
import { ScanStopError } from '@mergepilot/webscan';
import { WebScanAbortRegistry } from './abort.js';

describe('shutdown of the scan abort registry', () => {
  it('aborts the current run and every run delivered after shutdown', () => {
    const registry = new WebScanAbortRegistry();
    const current = registry.begin('current');
    registry.shutdown();
    expect(current.signal.aborted).toBe(true);
    registry.end(current);

    const late = registry.begin('delivered-during-close');
    expect(late.signal.aborted).toBe(true);
    expect(late.reason).toBe('shutdown');
    expect(late.signal.reason).toBeInstanceOf(ScanStopError);
    late.abort('cancelled');
    expect(late.reason).toBe('shutdown');
  });
});

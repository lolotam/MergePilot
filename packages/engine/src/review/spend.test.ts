import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { describeCallError, hasRealUsage, requestedOutputTokens, SpendTracker } from './spend.js';

const pricing = { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 1, cacheWritePerMTok: 1 };
const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe('SpendTracker', () => {
  it('charges real cost when usage is reported', () => {
    const s = new SpendTracker(pricing, 1);
    s.record(1000, 4096, usage(1000, 100));
    expect(s.spentUsd).toBeCloseTo((1000 * 1 + 100 * 10) / 1e6, 10);
  });

  it('charges the ESTIMATED cost when usage is missing or all-zero', () => {
    const s = new SpendTracker(pricing, 1);
    s.record(1000, 4096, undefined);
    s.record(1000, 4096, usage(0, 0));
    const one = (1000 * 1 + 4096 * 10) / 1e6;
    expect(s.spentUsd).toBeCloseTo(2 * one, 10);
  });

  it('accumulates so later calls are checked against what is left', () => {
    const s = new SpendTracker(pricing, 0.1);
    expect(s.canAfford(0, 8192)).toBe(true); // $0.08192
    s.record(0, 8192, undefined);
    expect(s.canAfford(0, 4096)).toBe(false); // 0.08192 + 0.04096 > 0.1
  });

  it('never blocks without pricing', () => {
    const s = new SpendTracker(undefined, 0.01);
    s.record(1e6, 1e6, undefined);
    expect(s.spentUsd).toBe(0);
    expect(s.canAfford(1e6, 1e6)).toBe(true);
  });

  it('requires the next affordability check only after it is requested', () => {
    const s = new SpendTracker(pricing, 1);
    expect(s.mustCheckNext).toBe(false);
    s.requireAffordableNext();
    expect(s.mustCheckNext).toBe(true);
  });
});

describe('spend helpers', () => {
  it('hasRealUsage treats zero input as unreported', () => {
    expect(hasRealUsage(undefined)).toBe(false);
    expect(hasRealUsage(usage(0, 50))).toBe(false);
    expect(hasRealUsage(usage(10, 0))).toBe(true);
  });

  it('requestedOutputTokens includes thinking headroom when the model reports it', () => {
    expect(requestedOutputTokens({ label: 'x', generate: async () => ({ text: '', finishReason: 'stop' }) }, 4096)).toBe(4096);
    expect(
      requestedOutputTokens(
        { label: 'x', outputTokensFor: (m) => m + 8192, generate: async () => ({ text: '', finishReason: 'stop' }) },
        4096,
      ),
    ).toBe(12288);
  });

  it('describeCallError returns the failure code, else a redacted message', () => {
    expect(describeCallError({ code: 'rate-limit', message: 'slow down' })).toBe('rate-limit');
    const raw = ['s', 'k-', 'q'.repeat(20)].join('');
    const key = new Secret(raw);
    const text = describeCallError(new Error(`bad key ${raw}`), [key]);
    expect(text).not.toContain(raw);
  });
});

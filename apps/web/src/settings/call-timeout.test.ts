import { describe, expect, it } from 'vitest';
import { formatCallTimeoutSeconds, parseCallTimeoutSeconds } from './call-timeout.js';

describe('the call timeout field (ADR-0048)', () => {
  it('shows the stored milliseconds in seconds', () => {
    expect(formatCallTimeoutSeconds(null)).toBe('');
    expect(formatCallTimeoutSeconds(undefined)).toBe('');
    expect(formatCallTimeoutSeconds(60_000)).toBe('60');
    expect(formatCallTimeoutSeconds(1_500)).toBe('1.5');
    expect(formatCallTimeoutSeconds(1_100)).toBe('1.1');
    expect(formatCallTimeoutSeconds(1_234)).toBe('1.234');
    expect(formatCallTimeoutSeconds(1_200_000)).toBe('1200');
  });

  it('reads the typed seconds as whole milliseconds', () => {
    expect(parseCallTimeoutSeconds('')).toEqual({ kind: 'empty' });
    expect(parseCallTimeoutSeconds('   ')).toEqual({ kind: 'empty' });
    expect(parseCallTimeoutSeconds('1')).toEqual({ kind: 'ok', ms: 1_000 });
    expect(parseCallTimeoutSeconds('600')).toEqual({ kind: 'ok', ms: 600_000 });
    expect(parseCallTimeoutSeconds('1.5')).toEqual({ kind: 'ok', ms: 1_500 });
    expect(parseCallTimeoutSeconds('1200')).toEqual({ kind: 'ok', ms: 1_200_000 });
  });

  it('round-trips every value it shows', () => {
    for (const ms of [1_000, 1_100, 1_234, 1_500, 600_000, 1_200_000]) {
      expect(parseCallTimeoutSeconds(formatCallTimeoutSeconds(ms))).toEqual({ kind: 'ok', ms });
    }
  });

  it('refuses what the API would refuse', () => {
    expect(parseCallTimeoutSeconds('abc')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('-5')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('1e3')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('NaN')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('Infinity')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('1,5')).toEqual({ kind: 'invalid' });
    // A fraction of a millisecond is not a whole millisecond.
    expect(parseCallTimeoutSeconds('1.5001')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('0.9999')).toEqual({ kind: 'invalid' });
    expect(parseCallTimeoutSeconds('99999999999999999999')).toEqual({ kind: 'invalid' });
  });

  it('refuses a value out of range instead of clamping it', () => {
    expect(parseCallTimeoutSeconds('0')).toEqual({ kind: 'outOfRange' });
    expect(parseCallTimeoutSeconds('0.999')).toEqual({ kind: 'outOfRange' });
    expect(parseCallTimeoutSeconds('1200.001')).toEqual({ kind: 'outOfRange' });
    expect(parseCallTimeoutSeconds('1201')).toEqual({ kind: 'outOfRange' });
  });
});

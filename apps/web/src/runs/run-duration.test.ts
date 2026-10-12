import { describe, expect, it } from 'vitest';
import { ar, type I18nKey } from '../i18n/ar.js';
import { en } from '../i18n/en.js';
import type { Language } from '../i18n/context.js';
import { elapsedMs, formatDurationMs, isActiveRun, runDurationMs } from './run-duration.js';

const translator = (language: Language) => (key: I18nKey, params?: Record<string, string | number>) => {
  let text: string = (language === 'ar' ? ar : en)[key];
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};
const fmtEn = (ms: number | null | undefined) => formatDurationMs(ms, 'en', translator('en'));
const fmtAr = (ms: number | null | undefined) => formatDurationMs(ms, 'ar', translator('ar'));

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe('formatDurationMs', () => {
  it('formats seconds, minutes and hours compactly with padded second unit', () => {
    expect(fmtEn(0)).toBe('0s');
    expect(fmtEn(999)).toBe('0s');
    expect(fmtEn(45 * SEC)).toBe('45s');
    expect(fmtEn(59 * SEC + 999)).toBe('59s');
    expect(fmtEn(60 * SEC)).toBe('1m 00s');
    expect(fmtEn(3 * MIN + 12 * SEC)).toBe('3m 12s');
    expect(fmtEn(3 * MIN + 5 * SEC)).toBe('3m 05s');
    expect(fmtEn(59 * MIN + 59 * SEC)).toBe('59m 59s');
    expect(fmtEn(HOUR + 4 * MIN + 30 * SEC)).toBe('1h 04m');
    expect(fmtEn(26 * HOUR)).toBe('26h 00m');
  });

  it('never groups digits (no thousands separator in large hour counts)', () => {
    expect(fmtEn(1234 * HOUR)).toBe('1234h 00m');
  });

  it('uses Arabic-Indic digits and Arabic units in Arabic, like the token columns', () => {
    expect(fmtAr(45 * SEC)).toBe('٤٥ ث');
    expect(fmtAr(3 * MIN + 5 * SEC)).toBe('٣ د ٠٥ ث');
    expect(fmtAr(HOUR + 4 * MIN)).toBe('١ س ٠٤ د');
  });

  it('shows "—" when the duration is unknown or invalid', () => {
    expect(fmtEn(null)).toBe('—');
    expect(fmtEn(undefined)).toBe('—');
    expect(fmtEn(-1)).toBe('—');
    expect(fmtEn(Number.NaN)).toBe('—');
    expect(fmtAr(null)).toBe('—');
  });
});

describe('runDurationMs', () => {
  const base = { createdAt: '2026-10-15T10:00:00.000Z', finishedAt: '2026-10-15T10:01:15.000Z' };

  it("prefers the server's durationMs, including an explicit null", () => {
    expect(runDurationMs({ ...base, status: 'completed', durationMs: 5000 })).toBe(5000);
    expect(runDurationMs({ ...base, status: 'completed', durationMs: null })).toBeNull();
  });

  it('falls back to finishedAt - createdAt when the server does not send it', () => {
    expect(runDurationMs({ ...base, status: 'failed' })).toBe(75 * SEC);
    expect(runDurationMs({ ...base, status: 'completed', finishedAt: null })).toBeNull();
    expect(runDurationMs({ ...base, status: 'completed', finishedAt: '2026-10-15T09:00:00.000Z' })).toBeNull();
  });

  it('is null for queued and running runs', () => {
    expect(isActiveRun({ status: 'queued' })).toBe(true);
    expect(isActiveRun({ status: 'skipped' })).toBe(false);
    expect(runDurationMs({ ...base, status: 'running', durationMs: 5000 })).toBeNull();
    expect(runDurationMs({ ...base, status: 'queued' })).toBeNull();
  });
});

describe('elapsedMs', () => {
  it('is the time since creation and never negative', () => {
    const created = '2026-10-15T10:00:00.000Z';
    expect(elapsedMs(created, Date.parse(created) + 42 * SEC)).toBe(42 * SEC);
    expect(elapsedMs(created, Date.parse(created) - SEC)).toBe(0);
  });
});

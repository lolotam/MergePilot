import type { ReviewRun } from '../api/client.js';
import type { I18nKey } from '../i18n/ar.js';
import type { Language } from '../i18n/context.js';

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** Queued and running runs have no duration yet; the table shows a live elapsed timer instead. */
export function isActiveRun(run: Pick<ReviewRun, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/**
 * A finished run's duration in ms: the server's `durationMs`, or (from an older server that does
 * not send it) finishedAt - createdAt. Null while the run is active or when unknown.
 */
export function runDurationMs(run: Pick<ReviewRun, 'status' | 'createdAt' | 'finishedAt' | 'durationMs'>): number | null {
  if (isActiveRun(run)) return null;
  if (run.durationMs !== undefined) return run.durationMs;
  if (!run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Time since an active run was created, in ms (never negative). */
export function elapsedMs(createdAt: string, now: number): number {
  const ms = now - new Date(createdAt).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * `45s`, `3m 05s`, `1h 04m` with the language's digits (Arabic-Indic in Arabic, like the token
 * columns); "—" when unknown. Whole seconds, rounded down.
 */
export function formatDurationMs(ms: number | null | undefined, language: Language, t: Translate): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const locale = language === 'ar' ? 'ar-EG' : 'en-US';
  const num = new Intl.NumberFormat(locale, { useGrouping: false }).format;
  const pad = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }).format;
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t('durationHours', { h: num(hours), m: pad(minutes) });
  if (minutes > 0) return t('durationMinutes', { m: num(minutes), s: pad(seconds) });
  return t('durationSeconds', { s: num(seconds) });
}

import { AlertCircle, CheckCircle2, Clock, Loader2, SkipForward } from 'lucide-react';
import type { ReviewRun } from '../api/client.js';
import { useI18n, type Language } from '../i18n/context.js';

const badge = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold whitespace-nowrap';

export function RunStatusBadge({ status }: { status: ReviewRun['status'] }) {
  const { t } = useI18n();
  switch (status) {
    case 'completed':
      return (
        <span className={`${badge} bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300`}>
          <CheckCircle2 className="w-3 h-3" />
          <span>{t('statusCompleted')}</span>
        </span>
      );
    case 'running':
      return (
        <span className={`${badge} bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300`}>
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{t('statusRunning')}</span>
        </span>
      );
    case 'queued':
      return (
        <span className={`${badge} bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300`}>
          <Clock className="w-3 h-3" />
          <span>{t('statusQueued')}</span>
        </span>
      );
    case 'skipped':
      return (
        <span className={`${badge} bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300`}>
          <SkipForward className="w-3 h-3" />
          <span>{t('statusSkipped')}</span>
        </span>
      );
    case 'failed':
    default:
      return (
        <span className={`${badge} bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300`}>
          <AlertCircle className="w-3 h-3" />
          <span>{t('statusFailed')}</span>
        </span>
      );
  }
}

/** Token count with locale thousands separators; "—" when usage is unknown. */
export function formatTokens(value: number | null | undefined, language: Language): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US').format(value);
}

/** Token counts in the table: compact from 10,000 up (152.3K); the exact number is the tooltip. */
export function RunTokens({ value }: { value: number | null | undefined }) {
  const { language } = useI18n();
  const exact = formatTokens(value, language);
  if (value === null || value === undefined || value < 10_000) return <span>{exact}</span>;
  const compact = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
  return <span title={exact}>{compact}</span>;
}

export function formatCost(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;
}

/** Queued and running runs are never deleted (the server skips them too). */
export function isDeletable(run: Pick<ReviewRun, 'status'>): boolean {
  return run.status !== 'queued' && run.status !== 'running';
}

/** A run's start time on two short lines (date, time); the full timestamp is in the tooltip. */
export function RunDate({ value }: { value: string }) {
  const { language } = useI18n();
  const date = new Date(value);
  const locale = language === 'ar' ? 'ar-EG' : 'en-US';
  return (
    <span className="inline-flex flex-col leading-tight" title={date.toLocaleString(locale)}>
      <span>{date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
      <span className="text-[10px] text-ink-400 dark:text-ink-500 tabular-nums">
        {date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
      </span>
    </span>
  );
}

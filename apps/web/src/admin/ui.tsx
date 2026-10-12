import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import type { AdminPageInfo } from '../api/admin.js';

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs p-5 flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100 tabular-nums">
        {value}
      </span>
      {hint && <span className="text-xs text-gray-500 dark:text-gray-400">{hint}</span>}
    </div>
  );
}

/** Card whose table scrolls horizontally inside the card on narrow screens. */
export function TableCard({
  toolbar,
  footer,
  children,
}: {
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs overflow-hidden">
      {toolbar && (
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200 dark:border-ink-800">
          {toolbar}
        </div>
      )}
      <div className="overflow-x-auto">{children}</div>
      {footer}
    </div>
  );
}

export const thClass = 'py-3 px-4 text-start font-medium whitespace-nowrap';
export const tdClass = 'py-3 px-4 align-top';
export const theadClass =
  'bg-gray-50/75 dark:bg-ink-800/50 border-b border-gray-200 dark:border-ink-800 text-xs text-gray-500 dark:text-gray-400';
export const tbodyClass = 'divide-y divide-gray-100 dark:divide-ink-800/60';

type Tone = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

const toneClasses: Record<Tone, string> = {
  brand: 'bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300',
  neutral: 'bg-gray-100 text-gray-700 dark:bg-ink-800 dark:text-gray-300',
  success: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  danger: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  completed: 'success',
  running: 'brand',
  queued: 'warning',
  skipped: 'neutral',
  failed: 'danger',
};

const statusKey = {
  completed: 'statusCompleted',
  running: 'statusRunning',
  queued: 'statusQueued',
  skipped: 'statusSkipped',
  failed: 'statusFailed',
} as const;

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const key = statusKey[status as keyof typeof statusKey];
  return <Badge tone={statusTone[status] ?? 'neutral'}>{key ? t(key) : status}</Badge>;
}

export function StateMessage({ children }: { children: ReactNode }) {
  return (
    <div className="py-12 px-4 text-center text-sm text-gray-500 dark:text-gray-400">{children}</div>
  );
}

export function Pager({
  page,
  onChange,
}: {
  page: AdminPageInfo | undefined;
  onChange: (offset: number) => void;
}) {
  const { t, dir } = useI18n();
  if (!page || page.total <= page.limit) return null;
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);
  const PrevIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const NextIcon = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const button =
    'inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-ink-700 hover:bg-gray-100 dark:hover:bg-ink-800 disabled:opacity-40 disabled:pointer-events-none focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

  return (
    <div className="flex items-center justify-between gap-3 p-4 border-t border-gray-200 dark:border-ink-800 text-xs text-gray-500 dark:text-gray-400">
      <span>{t('adminPageRange', { from, to, total: page.total })}</span>
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={page.offset === 0}
          onClick={() => onChange(Math.max(page.offset - page.limit, 0))}
        >
          <PrevIcon className="w-3.5 h-3.5" />
          <span>{t('adminPagePrev')}</span>
        </button>
        <button
          type="button"
          className={button}
          disabled={to >= page.total}
          onClick={() => onChange(page.offset + page.limit)}
        >
          <span>{t('adminPageNext')}</span>
          <NextIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

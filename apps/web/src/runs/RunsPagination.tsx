import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

interface RunsPaginationProps {
  limit: number;
  offset: number;
  total: number;
  onPageChange: (newOffset: number) => void;
}

export function RunsPagination({ limit, offset, total, onPageChange }: RunsPaginationProps) {
  const { t } = useI18n();

  if (total <= 0) return null;

  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  const rangeText = t('paginationRange')
    .replace('{from}', String(from))
    .replace('{to}', String(to))
    .replace('{total}', String(total));

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-ink-200 dark:border-ink-700 text-xs text-ink-600 dark:text-ink-400">
      <div>{rangeText}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight className="w-3.5 h-3.5 rtl:rotate-0 ltr:rotate-180" />
          <span>{t('paginationPrev')}</span>
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPageChange(offset + limit)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span>{t('paginationNext')}</span>
          <ChevronLeft className="w-3.5 h-3.5 rtl:rotate-0 ltr:rotate-180" />
        </button>
      </div>
    </div>
  );
}

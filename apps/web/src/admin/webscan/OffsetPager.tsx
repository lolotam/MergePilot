import { useI18n } from '../../i18n/context.js';

/**
 * The pager of a list the server counts without a total.
 *
 * The scan history answers with a page and no total, so the pager cannot know
 * whether a last page follows. (The audit log carries a total and uses the
 * shared total-aware pager.) It uses the size of the page
 * instead: a page that is not full is the last one.
 *
 * A page that is empty but not the first one keeps the pager: it is the way
 * back to the pages before it, and the administrator reached it by paging.
 */
export interface OffsetPagerProps {
  offset: number;
  limit: number;
  /** The number of rows of the current page. */
  count: number;
  onChange: (offset: number) => void;
}

export function OffsetPager({ offset, limit, count, onChange }: OffsetPagerProps) {
  const { t } = useI18n();
  // There is nothing to page through.
  if (count === 0 && offset === 0) return null;
  const from = offset + 1;
  const to = offset + count;
  const button =
    'inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-40 disabled:pointer-events-none focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

  return (
    <div className="flex items-center justify-between gap-3 p-4 border-t border-ink-200 dark:border-ink-800 text-xs text-ink-500 dark:text-ink-400">
      {/* An empty page has no rows to range over. */}
      <span>{count > 0 ? t('webscanPageRange', { from, to }) : ''}</span>
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={offset === 0}
          onClick={() => onChange(Math.max(offset - limit, 0))}
        >
          {t('webscanPagePrev')}
        </button>
        <button
          type="button"
          className={button}
          disabled={count < limit}
          onClick={() => onChange(offset + limit)}
        >
          {t('webscanPageNext')}
        </button>
      </div>
    </div>
  );
}

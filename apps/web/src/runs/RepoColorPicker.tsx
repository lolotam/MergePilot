import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { RepoColorKey } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import { REPO_PALETTE, colorLabelKey, type RepoColor } from './repo-colors.js';

/** Dot + `owner/repo`; the name is always shown, so color is never the only cue. */
/** A repository chip in its color; `short` shows only the repo name (the full name is in the tooltip). */
export function RepoChip({
  repo,
  color,
  className = '',
  short = false,
}: {
  repo: string;
  color: RepoColor;
  className?: string;
  short?: boolean;
}) {
  return (
    <span
      dir="ltr"
      data-repo-color={color.key}
      title={repo}
      className={`inline-flex items-center gap-1.5 ${short ? 'max-w-[104px]' : 'max-w-[220px]'} px-2 py-0.5 rounded-full text-[11px] font-mono font-medium ${color.chip} ${className}`}
    >
      <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${color.dot}`} />
      <span className="truncate">{short ? repo.slice(repo.indexOf('/') + 1) : repo}</span>
    </span>
  );
}

interface RepoColorSwatchesProps {
  repo: string;
  /** The stored choice; undefined = Auto (hashed default). */
  selected: RepoColorKey | undefined;
  disabled?: boolean;
  onPick: (color: RepoColorKey | null) => void;
}

/** The palette as a radio-like row of swatches plus "Auto". */
export function RepoColorSwatches({ repo, selected, disabled = false, onPick }: RepoColorSwatchesProps) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t('repoColorPick', { repo })} className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={selected === undefined}
        onClick={() => onPick(null)}
        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          selected === undefined
            ? 'border-brand-600 text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/40'
            : 'border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800'
        }`}
      >
        {t('repoColorAuto')}
      </button>
      {REPO_PALETTE.map((c) => (
        <button
          key={c.key}
          type="button"
          disabled={disabled}
          aria-pressed={selected === c.key}
          aria-label={t(colorLabelKey(c.key))}
          title={t(colorLabelKey(c.key))}
          onClick={() => onPick(c.key)}
          className={`w-5 h-5 rounded-full inline-flex items-center justify-center ${c.dot} ring-offset-1 ring-offset-white dark:ring-offset-ink-900 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed ${
            selected === c.key ? 'ring-2 ring-ink-900 dark:ring-ink-100' : 'hover:ring-2 hover:ring-ink-300 dark:hover:ring-ink-600'
          }`}
        >
          {selected === c.key ? <Check className="w-3 h-3 text-white" aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  );
}

/** A small popover with the swatches, closed by Escape or a click outside. */
export function RepoColorPopover({
  onClose,
  ...swatches
}: RepoColorSwatchesProps & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={swatches.repo}
      className="absolute z-30 top-full mt-1.5 start-0 p-2.5 w-64 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-lg"
    >
      <RepoColorSwatches {...swatches} />
    </div>
  );
}

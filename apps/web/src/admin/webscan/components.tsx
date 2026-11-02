import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Badge } from '../ui.js';

/**
 * The shared pieces of the website scan panels.
 *
 * The switch follows the switch of the settings pages: a button with
 * `role="switch"`, a logical `start` offset and the mirrored slide in RTL.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name of the switch. */
  label: string;
  /** The id of the hint the switch describes. */
  describedBy?: string | undefined;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, describedBy, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${
        checked ? 'bg-green-500' : 'bg-ink-300 dark:bg-ink-700'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 start-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4 rtl:-translate-x-4' : ''
        }`}
      />
    </button>
  );
}

/** A card of the settings panels: a title, a hint and a body. */
export function SettingsCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5">
      <h2 className="text-xs font-bold text-ink-900 dark:text-ink-100">{title}</h2>
      {hint && <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The label of a field, with its optional hint and its error. */
export function FieldLabel({
  htmlFor,
  children,
  hint,
  error,
  hintId,
  errorId,
}: {
  htmlFor: string;
  children: ReactNode;
  hint?: string;
  error?: string | undefined;
  hintId?: string;
  errorId?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
        {children}
      </label>
      {hint && (
        <p id={hintId} className="text-[11px] text-ink-500 dark:text-ink-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** The class of the text inputs and the selects of the panels. */
export const inputClass =
  'w-full px-3.5 py-2 text-xs rounded-md border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-950 focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

/**
 * Where an effective value comes from: the global default of the policy, or a
 * value that is set for this site (ADR-0052 section 5).
 */
export function SourceBadge({ source }: { source: 'global' | 'site' }) {
  const { t } = useI18n();
  return (
    <Badge tone={source === 'global' ? 'neutral' : 'brand'}>
      {source === 'global' ? t('webscanSourceGlobal') : t('webscanSourceSite')}
    </Badge>
  );
}


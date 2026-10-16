import type { Settings } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';

export type MaxFindings = NonNullable<Settings['maxFindings']>;

// The server's MAX_FINDINGS_CHOICES (type-checked; the web never imports server runtime code).
export const MAX_FINDINGS_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const satisfies ReadonlyArray<MaxFindings>;
export const DEFAULT_MAX_FINDINGS: MaxFindings = 5;

export interface MaxFindingsSelectProps {
  value: MaxFindings;
  onChange: (value: MaxFindings) => void;
  disabled?: boolean;
}

/** «Maximum review comments per PR review» (ADR-0033): 5 to 50 in steps of 5. */
export function MaxFindingsSelect({ value, onChange, disabled = false }: MaxFindingsSelectProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="settings-max-findings" className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
        {t('maxFindingsLabel')}
      </label>
      <select
        id="settings-max-findings"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) as MaxFindings)}
        className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
      >
        {MAX_FINDINGS_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 ms-1">{t('maxFindingsHint')}</p>
    </div>
  );
}

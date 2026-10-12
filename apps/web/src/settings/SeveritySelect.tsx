import type { Severity } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';

export interface SeveritySelectProps {
  value: Severity;
  onChange: (val: Severity) => void;
  disabled?: boolean;
}

export function SeveritySelect({ value, onChange, disabled = false }: SeveritySelectProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="settings-min-severity" className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
        {t('minSeverityLabel')}
      </label>
      <select
        id="settings-min-severity"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Severity)}
        className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
      >
        <option value="low">{t('severityLow')}</option>
        <option value="medium">{t('severityMedium')}</option>
        <option value="high">{t('severityHigh')}</option>
        <option value="critical">{t('severityCritical')}</option>
      </select>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 ms-1">
        {t('minSeverityHint')}
      </p>
    </div>
  );
}

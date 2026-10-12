import { useI18n } from '../i18n/context.js';

export interface EffortSelectProps {
  efforts: string[];
  value: string | null | undefined;
  onChange: (effort: string | null) => void;
  disabled?: boolean;
}

export function EffortSelect({ efforts, value, onChange, disabled = false }: EffortSelectProps) {
  const { t } = useI18n();

  if (!efforts || efforts.length === 0) {
    return null;
  }

  const getEffortLabel = (effort: string) => {
    switch (effort.toLowerCase()) {
      case 'low': return t('effortLow');
      case 'medium': return t('effortMedium');
      case 'high': return t('effortHigh');
      default: return effort;
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
        {t('effortLabel')}
      </label>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const val = e.target.value;
          onChange(val ? val : null);
        }}
        className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
      >
        <option value="">{t('effortNone')}</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {getEffortLabel(effort)}
          </option>
        ))}
      </select>
    </div>
  );
}

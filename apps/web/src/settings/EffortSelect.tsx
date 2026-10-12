import type { I18nKey } from '../i18n/ar.js';
import { useI18n } from '../i18n/context.js';
import { fieldClass, labelClass } from './providers.js';

export interface EffortSelectProps {
  /** The efforts the chosen model takes; the select is hidden when there are none. */
  efforts: string[];
  value: string | null | undefined;
  onChange: (effort: string | null) => void;
  disabled?: boolean;
  id: string;
  label?: string | undefined;
}

const EFFORT_LABELS: Record<string, I18nKey> = {
  off: 'effortOff',
  on: 'effortOn',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
};

/** Keeps `effort` only when the newly chosen model still takes it. */
export function effortFor(efforts: readonly string[], effort: string | null | undefined): string | null {
  return effort && efforts.includes(effort) ? effort : null;
}

export function EffortSelect({ efforts, value, onChange, disabled = false, id, label }: EffortSelectProps) {
  const { t } = useI18n();
  if (efforts.length === 0) return null;

  const effortLabel = (effort: string) => {
    const key = EFFORT_LABELS[effort.toLowerCase()];
    return key ? t(key) : effort;
  };

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label ?? t('effortLabel')}
      </label>
      <select
        id={id}
        value={value && efforts.includes(value) ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className={fieldClass}
      >
        <option value="">{t('effortNone')}</option>
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effortLabel(effort)}
          </option>
        ))}
      </select>
    </div>
  );
}

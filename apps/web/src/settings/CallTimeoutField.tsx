import { useI18n } from '../i18n/context.js';
import { fieldClass, labelClass } from './providers.js';

export interface CallTimeoutFieldProps {
  id: string;
  /** The typed seconds; '' = inherit the repository's timeout. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The message of a refused value; the field is marked invalid while it is set. */
  error?: string | undefined;
}

/**
 * A bot's call timeout in seconds (ADR-0048): an empty field inherits the repository's timeout,
 * a value is sent as whole milliseconds.
 */
export function CallTimeoutField({ id, value, onChange, disabled = false, error }: CallTimeoutFieldProps) {
  const { t } = useI18n();

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {t('callTimeoutLabel')}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        dir="ltr"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
        aria-invalid={Boolean(error)}
        className={error ? `${fieldClass} border-red-500 focus:ring-red-500` : fieldClass}
      />
      <p id={`${id}-hint`} className="text-[11px] text-ink-500 dark:text-ink-400 ms-1">{t('callTimeoutHint')}</p>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-red-500 mt-1 ms-2">{error}</p>}
    </div>
  );
}

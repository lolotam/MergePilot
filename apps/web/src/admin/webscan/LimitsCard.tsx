import { useId } from 'react';
import type { WebScanLimits } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatCount } from '../format.js';
import { Badge } from '../ui.js';
import { SettingsCard } from './components.js';
import { WEB_SCAN_LIMIT_ROWS } from './limit-rows.js';
import { WEB_SCAN_LIMIT_SPECS, limitsAboveDefault } from './limits.js';

/**
 * The limits of the global policy (ADR-0052 section 5).
 *
 * Every limit shows its unit and its default, and a value above the default is
 * marked: the server asks for a second confirmation for it.
 */
export interface LimitsCardProps {
  limits: WebScanLimits;
  onChange: (limits: WebScanLimits) => void;
}

export function LimitsCard({ limits, onChange }: LimitsCardProps) {
  const { t } = useI18n();
  const above = limitsAboveDefault(limits);

  return (
    <SettingsCard title={t('webscanLimitsTitle')} hint={t('webscanLimitsDesc')}>
      <div className="flex flex-col gap-3">
        {WEB_SCAN_LIMIT_ROWS.map((row) => (
          <LimitRow
            key={row.field}
            field={row.field}
            label={t(row.label)}
            unit={t(row.unit)}
            value={limits[row.field]}
            aboveDefault={above.includes(row.field)}
            onChange={(value) => {
              const next: WebScanLimits = { ...limits };
              next[row.field] = value;
              onChange(next);
            }}
          />
        ))}
      </div>
    </SettingsCard>
  );
}

function LimitRow({
  field,
  label,
  unit,
  value,
  aboveDefault,
  onChange,
}: {
  field: keyof WebScanLimits;
  label: string;
  unit: string;
  value: number;
  aboveDefault: boolean;
  onChange: (value: number) => void;
}) {
  const { t, language } = useI18n();
  const inputId = useId();
  const spec = WEB_SCAN_LIMIT_SPECS[field];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex-1 min-w-[12rem]">
        <label htmlFor={inputId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {label}
        </label>
        <p className="text-[11px] text-ink-500 dark:text-ink-400">
          {t('webscanLimitRange', {
            min: formatCount(spec.min, language),
            max: formatCount(spec.max, language),
          })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28 px-3 py-1.5 text-xs rounded-md border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-950 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
        />
        <span className="text-[11px] text-ink-500 dark:text-ink-400 w-28">{unit}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink-500 dark:text-ink-400">
          {t('webscanLimitDefault', {
            value: `${formatCount(spec.default, language)} ${unit}`,
          })}
        </span>
        {aboveDefault && <Badge tone="warning">{t('webscanAboveDefaultBadge')}</Badge>}
      </div>
    </div>
  );
}

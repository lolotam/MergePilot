import type { WebScanChecks } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { SettingsCard, Toggle } from './components.js';

/**
 * The six catalogue checks of ADR-0052 section 3.
 *
 * A check is switched off with its own switch, never with a zero budget.
 */
const CHECK_ROWS = [
  { field: 'headers', label: 'webscanCheckHeaders' },
  { field: 'cookies', label: 'webscanCheckCookies' },
  { field: 'transport', label: 'webscanCheckTransport' },
  { field: 'disclosure', label: 'webscanCheckDisclosure' },
  { field: 'files', label: 'webscanCheckFiles' },
  { field: 'active', label: 'webscanCheckActive' },
] as const;

export interface ChecksCardProps {
  checks: WebScanChecks;
  onChange: (checks: WebScanChecks) => void;
}

export function ChecksCard({ checks, onChange }: ChecksCardProps) {
  const { t } = useI18n();

  return (
    <SettingsCard title={t('webscanChecksTitle')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {CHECK_ROWS.map((row) => (
          <div key={row.field} className="flex items-center gap-2">
            <Toggle
              checked={checks[row.field]}
              label={t(row.label)}
              onChange={(checked) => {
                const next: WebScanChecks = { ...checks };
                next[row.field] = checked;
                onChange(next);
              }}
            />
            <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">{t(row.label)}</span>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

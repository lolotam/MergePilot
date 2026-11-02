import type { WebScanApprovedInstallation } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { Badge } from '../ui.js';
import { SettingsCard } from './components.js';

/**
 * The approved alert bindings of the global policy (ADR-0052 section 8).
 *
 * The list is read-only here: every binding is verified against GitHub before
 * it is saved, and that verifying endpoint arrives with the alerts work, so the
 * dashboard never writes it.
 */
export interface ApprovedInstallationsCardProps {
  installations: WebScanApprovedInstallation[];
}

export function ApprovedInstallationsCard({ installations }: ApprovedInstallationsCardProps) {
  const { t } = useI18n();

  return (
    <SettingsCard title={t('webscanApprovedTitle')} hint={t('webscanApprovedDesc')}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Badge tone="neutral">{t('webscanReadOnly')}</Badge>
      </div>
      {installations.length === 0 ? (
        <p className="text-xs text-ink-500 dark:text-ink-400">{t('webscanEmptyApprovedInstallations')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {installations.map((entry) => (
            <li
              key={`${entry.adminUserId}-${entry.installationId}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-700 dark:text-ink-300"
            >
              <span className="font-semibold text-ink-900 dark:text-ink-100">{entry.adminUserId}</span>
              <span className="text-ink-500 dark:text-ink-400">#{entry.installationId}</span>
              <span className="text-ink-500 dark:text-ink-400">#{entry.githubAccountId}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

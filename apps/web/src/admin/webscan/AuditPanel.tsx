import { useState } from 'react';
import { useI18n } from '../../i18n/context.js';
import { formatDateTime } from '../format.js';
import { Pager, TableCard, tbodyClass, tdClass, thClass, theadClass } from '../ui.js';
import { useWebScanAuditQuery } from './hooks.js';
import { EmptyState, ErrorState, LoadingState, PermissionLostState } from './states.js';
import { isPermissionLost } from './hooks.js';

/**
 * The audit log of the scanner (ADR-0052 section 10).
 *
 * The log is append-only: the store exposes no update and no delete, and the
 * panel offers no control that could change a row. The newest entry is first.
 */
export function AuditPanel() {
  const { t, language } = useI18n();
  const [offset, setOffset] = useState(0);
  const audit = useWebScanAuditQuery(offset);

  if (audit.isError) {
    return isPermissionLost(audit.error) ? <PermissionLostState /> : <ErrorState />;
  }
  if (audit.isLoading) return <LoadingState />;

  const entries = audit.data?.audit ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="font-serif text-lg font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('webscanAuditTitle')}
        </h2>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">{t('webscanAuditDesc')}</p>
      </header>

      {entries.length === 0 ? (
        <EmptyState>{t('webscanEmptyAudit')}</EmptyState>
      ) : (
        <TableCard footer={<Pager page={audit.data} onChange={setOffset} />}>
          <table className="w-full text-start text-xs">
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>{t('webscanColTime')}</th>
                <th className={thClass}>{t('webscanColActor')}</th>
                <th className={thClass}>{t('webscanColAction')}</th>
                <th className={thClass}>{t('webscanColTarget')}</th>
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
                  <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                    {formatDateTime(entry.createdAt, language)}
                  </td>
                  <td className={tdClass}>{entry.actor}</td>
                  <td className={`${tdClass} font-mono text-ink-700 dark:text-ink-200`}>
                    {entry.action}
                  </td>
                  <td className={`${tdClass} text-ink-500 dark:text-ink-400`}>
                    {`${entry.targetType} · ${entry.targetId}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}

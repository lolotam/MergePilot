import type { WebScanScanDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatDateTime } from '../format.js';
import { Badge, TableCard, tbodyClass, tdClass, thClass, theadClass } from '../ui.js';
import { SCAN_STATUS_KEYS } from './labels.js';
import { OffsetPager } from './OffsetPager.js';

/**
 * The history of the scans of one site (ADR-0052 section 7).
 *
 * The list is a history and not a result: every scan of the site is here, with
 * the state it ended in, and the administrator opens the one they want to read.
 */
export interface ScanHistoryProps {
  scans: WebScanScanDto[];
  limit: number;
  offset: number;
  /** The scan the administrator is reading. */
  selectedScanId: string | undefined;
  onChangeOffset: (offset: number) => void;
  onSelect: (scanId: string) => void;
}

export function ScanHistory({
  scans,
  limit,
  offset,
  selectedScanId,
  onChangeOffset,
  onSelect,
}: ScanHistoryProps) {
  const { t, language } = useI18n();

  return (
    <TableCard footer={<OffsetPager offset={offset} limit={limit} count={scans.length} onChange={onChangeOffset} />}>
      <table className="w-full text-start text-xs">
        <caption className="sr-only">{t('webscanScanHistory')}</caption>
        <thead className={theadClass}>
          <tr>
            <th className={thClass}>{t('webscanColStatus')}</th>
            <th className={thClass}>{t('webscanColTrigger')}</th>
            <th className={thClass}>{t('webscanColStarted')}</th>
            <th className={thClass}>{t('webscanColFinished')}</th>
            <th className={thClass}>{t('webscanScanRequests')}</th>
            <th className={thClass}>{t('webscanScanPages')}</th>
            <th className={thClass}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {scans.map((scan) => (
            <tr key={scan.id} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
              <td className={tdClass}>
                <Badge tone={scan.status === 'failed' ? 'danger' : 'neutral'}>
                  {t(SCAN_STATUS_KEYS[scan.status])}
                </Badge>
              </td>
              <td className={tdClass}>
                {scan.trigger === 'manual'
                  ? t('webscanTriggerManual')
                  : t('webscanTriggerScheduled')}
              </td>
              <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                {formatDateTime(scan.startedAt ?? scan.createdAt, language)}
              </td>
              <td className={`${tdClass} whitespace-nowrap text-ink-500 dark:text-ink-400`}>
                {formatDateTime(scan.finishedAt, language)}
              </td>
              <td className={`${tdClass} tabular-nums text-ink-500 dark:text-ink-400`}>
                {scan.requests}
              </td>
              <td className={`${tdClass} tabular-nums text-ink-500 dark:text-ink-400`}>
                {scan.pages}
              </td>
              <td className={`${tdClass} text-end whitespace-nowrap`}>
                <button
                  type="button"
                  aria-label={`${t('webscanOpenScan')}: ${scan.id}`}
                  aria-pressed={scan.id === selectedScanId}
                  onClick={() => onSelect(scan.id)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                    scan.id === selectedScanId
                      ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                      : 'border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300'
                  }`}
                >
                  {t('webscanOpenScan')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

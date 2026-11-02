import type { WebScanScanDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { Badge } from '../ui.js';
import { SCAN_STATUS_KEYS, scanReasonKey } from './labels.js';
import type { ScanProgress } from './scan-events.js';

/**
 * The state of the scan the administrator is watching (ADR-0052 sections 6, 7).
 *
 * The counters of the live stream are the fresh view of the scan, and the
 * state of the scan itself comes from the server. The two are shown together:
 * the numbers move while the scan runs, and the status stays what the server
 * says.
 */

/** The tone of every status of a scan. */
const STATUS_TONES = {
  queued: 'warning',
  running: 'brand',
  completed: 'success',
  stopped: 'neutral',
  failed: 'danger',
} as const satisfies Record<
  WebScanScanDto['status'],
  'brand' | 'neutral' | 'success' | 'warning' | 'danger'
>;

export interface ScanStatusProps {
  scan: WebScanScanDto;
  /** The live counters of the stream, when the stream is open. */
  progress: ScanProgress | null;
  isStopping?: boolean;
  onStop?: () => void;
}

export function ScanStatus({ scan, progress, isStopping = false, onStop }: ScanStatusProps) {
  const { t } = useI18n();
  const active = scan.status === 'queued' || scan.status === 'running';
  const requests = progress?.requests ?? scan.requests;
  const pages = progress?.pages ?? scan.pages;
  const elapsedMs = progress?.elapsedMs ?? scan.durationMs;
  const partial = (scan.coverageSummary ?? []).some((entry) => entry.outcome !== 'checked');
  const reason = scan.stopReason ?? scan.failReason;
  const reasonKey = scanReasonKey(reason);

  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge tone={STATUS_TONES[scan.status]}>{t(SCAN_STATUS_KEYS[scan.status])}</Badge>
        {partial && <Badge tone="warning">{t('webscanPartialCoverage')}</Badge>}
        {reasonKey && (
          <span className="text-[11px] text-ink-500 dark:text-ink-400">{t(reasonKey)}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3" aria-live="polite">
        <Counter label={t('webscanScanRequests')} value={requests} />
        <Counter label={t('webscanScanPages')} value={pages} />
        <Counter
          label={t('webscanScanElapsed')}
          value={Math.max(0, Math.round(elapsedMs / 1000))}
        />
      </dl>

      {active && onStop && (
        <div>
          <button
            type="button"
            onClick={onStop}
            disabled={isStopping}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors disabled:opacity-50"
          >
            {isStopping ? t('webscanScanStopping') : t('webscanScanStop')}
          </button>
        </div>
      )}
    </section>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] text-ink-500 dark:text-ink-400">{label}</dt>
      <dd className="text-lg font-bold tabular-nums text-ink-900 dark:text-ink-100">{value}</dd>
    </div>
  );
}

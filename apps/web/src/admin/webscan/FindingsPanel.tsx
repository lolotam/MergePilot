import { useMemo, useState } from 'react';
import type { WebScanExceptionDto, WebScanScanDetail } from '@mergepilot/app/contract';
import { downloadScanExport } from '../../api/webscan.js';
import { useI18n } from '../../i18n/context.js';
import { groupOccurrences } from './findings.js';
import { CoverageSummary } from './CoverageSummary.js';
import { FindingsGroupCard } from './FindingsGroupCard.js';
import { EmptyState } from './states.js';

/**
 * The findings of one scan (ADR-0052 section 12).
 *
 * The findings are grouped by issue, and every occurrence keeps its own
 * validation, its own comparison and its own resolution. The report of the
 * scan is downloaded from the server: the dashboard never builds a report of
 * its own, so the file and the page cannot tell different stories.
 */
export interface FindingsPanelProps {
  detail: WebScanScanDetail;
  /** The resolutions of the site, so an excepted finding shows its end date. */
  exceptions: WebScanExceptionDto[];
}

/** The formats of the report the server renders. */
const EXPORT_FORMATS = ['html', 'json'] as const;

export function FindingsPanel({ detail, exceptions }: FindingsPanelProps) {
  const { t } = useI18n();
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const groups = useMemo(() => groupOccurrences(detail.occurrences), [detail.occurrences]);
  const exceptionMap = useMemo(() => {
    const map = new Map<string, WebScanExceptionDto>();
    for (const exception of exceptions) {
      map.set(exception.id, exception);
    }
    return map;
  }, [exceptions]);

  const download = async (format: (typeof EXPORT_FORMATS)[number]) => {
    setExporting(format);
    setExportError(null);
    try {
      const { filename, blob } = await downloadScanExport(detail.scan.id, format);
      if (!saveBlob(filename, blob)) {
        setExportError(t('webscanExportFailed'));
      }
    } catch {
      setExportError(t('webscanExportFailed'));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">
          {t('webscanFindingsTitle')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => void download(format)}
              disabled={exporting !== null}
              className="px-3 py-1.5 text-xs font-semibold rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors disabled:opacity-50"
            >
              {format === 'html' ? t('webscanExportHtml') : t('webscanExportJson')}
            </button>
          ))}
        </div>
      </div>

      {exportError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {exportError}
        </p>
      )}

      {groups.length === 0 ? (
        <EmptyState>{t('webscanEmptyFindings')}</EmptyState>
      ) : (
        groups.map((group) => (
          <FindingsGroupCard key={group.issueKey} group={group} exceptions={exceptionMap} />
        ))
      )}

      <CoverageSummary coverage={detail.coverage} />
    </div>
  );
}

/**
 * Hands the report to the browser as a download.
 *
 * The file name is the one the server sent, so a report never carries a name
 * of a target. The object URL is released right after the click.
 */
function saveBlob(filename: string, blob: Blob): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

import type { WebScanCoverageEntryDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { CHECK_KEYS, COVERAGE_OUTCOME_KEYS, COVERAGE_REASON_KEYS } from './labels.js';

/**
 * The coverage of a scan, per check (ADR-0052 section 4).
 *
 * The coverage says what the scan really looked at. A check that was not
 * evaluated, or that failed on a target, is shown here: a finding that was
 * never checked is never a remediation.
 */

/** The coverage of one check. */
interface CheckCoverage {
  checkId: WebScanCoverageEntryDto['checkId'];
  checked: number;
  error: number;
  notVisited: number;
  /** The reasons of the entries that were not checked. */
  reasons: NonNullable<WebScanCoverageEntryDto['reason']>[];
}

function coverageOf(entries: WebScanCoverageEntryDto[]): CheckCoverage[] {
  const grouped = new Map<WebScanCoverageEntryDto['checkId'], CheckCoverage>();
  for (const entry of entries) {
    const group = grouped.get(entry.checkId) ?? {
      checkId: entry.checkId,
      checked: 0,
      error: 0,
      notVisited: 0,
      reasons: [],
    };
    if (entry.outcome === 'checked') group.checked += 1;
    else if (entry.outcome === 'error') group.error += 1;
    else group.notVisited += 1;
    if (entry.reason !== null && !group.reasons.includes(entry.reason)) {
      group.reasons.push(entry.reason);
    }
    grouped.set(entry.checkId, group);
  }
  return [...grouped.values()];
}

export function CoverageSummary({ coverage }: { coverage: WebScanCoverageEntryDto[] }) {
  const { t } = useI18n();
  const checks = coverageOf(coverage);
  if (checks.length === 0) return null;

  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5">
      <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">{t('webscanCoverageTitle')}</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {checks.map((check) => (
          <li key={check.checkId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink-800 dark:text-ink-100">
              {t(CHECK_KEYS[check.checkId])}
            </span>
            <span className="text-ink-600 dark:text-ink-300">
              {t(COVERAGE_OUTCOME_KEYS.checked)}: {check.checked}
            </span>
            <span className="text-ink-600 dark:text-ink-300">
              {t(COVERAGE_OUTCOME_KEYS.error)}: {check.error}
            </span>
            <span className="text-ink-600 dark:text-ink-300">
              {t(COVERAGE_OUTCOME_KEYS['not-visited'])}: {check.notVisited}
            </span>
            {check.reasons.map((reason) => (
              <span key={reason} className="text-ink-500 dark:text-ink-400">
                {t('webscanCoverageReason')}: {t(COVERAGE_REASON_KEYS[reason])}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

import type { WebScanExceptionDto, WebScanOccurrenceDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatCount, formatDateTime } from '../format.js';
import { Badge } from '../ui.js';
import type { FindingsGroup } from './findings.js';
import {
  COMPARISON_KEYS,
  CONFIDENCE_KEYS,
  EXCEPTION_KIND_KEYS,
  SEVERITY_KEYS,
  VALIDATION_KEYS,
} from './labels.js';

/**
 * One group of findings: the occurrences of one issue (ADR-0052 section 4).
 *
 * Every member keeps its own validation, its own comparison and its own
 * resolution. A member that was never checked is never shown as fixed: it has
 * its own label and its own colour, so a missing check can never look like a
 * repair.
 */

/** The tone of every comparison state. */
const COMPARISON_TONES = {
  New: 'brand',
  Unchanged: 'neutral',
  Fixed: 'success',
  'Not checked': 'warning',
} as const satisfies Record<
  NonNullable<WebScanOccurrenceDto['comparison']>,
  'brand' | 'neutral' | 'success' | 'warning' | 'danger'
>;

export interface FindingsGroupCardProps {
  group: FindingsGroup;
  /** The exceptions of the site, by their id. */
  exceptions: Map<string, WebScanExceptionDto>;
}

export function FindingsGroupCard({ group, exceptions }: FindingsGroupCardProps) {
  const { t, language } = useI18n();

  return (
    <section className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs p-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold text-ink-900 dark:text-ink-100">{group.subject}</h3>
        <Badge
          tone={
            group.severity === 'critical' || group.severity === 'high' ? 'danger' : 'warning'
          }
        >
          {t(SEVERITY_KEYS[group.severity])}
        </Badge>
        <span className="text-[11px] text-ink-500 dark:text-ink-400">
          {t('webscanRiskScore')}: {formatCount(Number(group.score.toFixed(2)), language)}
        </span>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500 dark:text-ink-400">
        <li>
          {t('webscanRiskSeverityBase')}: {formatCount(group.factors.severityBase, language)}
        </li>
        <li>
          {t('webscanRiskConfidence')}: {formatCount(group.factors.confidence, language)}
        </li>
        <li>
          {t('webscanRiskValidation')}: {formatCount(group.factors.validation, language)}
        </li>
        <li>
          {t('webscanRiskSurface')}: {formatCount(Number(group.factors.surface.toFixed(2)), language)}
        </li>
        <li>
          {t('webscanRiskAffectedTargets')}: {formatCount(group.factors.affectedUrls, language)}
        </li>
      </ul>
      <p className="text-[11px] text-ink-500 dark:text-ink-400">{t('webscanRiskNotCvss')}</p>

      <ul className="flex flex-col gap-3">
        {group.occurrences.map((occurrence) => (
          <OccurrenceRow key={occurrence.occurrenceKey} occurrence={occurrence} exceptions={exceptions} />
        ))}
      </ul>
    </section>
  );
}

function OccurrenceRow({
  occurrence,
  exceptions,
}: {
  occurrence: WebScanOccurrenceDto;
  exceptions: Map<string, WebScanExceptionDto>;
}) {
  const { t, language } = useI18n();
  const comparison = occurrence.comparison ?? 'Not checked';
  const exception = occurrence.exceptionId === null ? undefined : exceptions.get(occurrence.exceptionId);

  return (
    <li className="flex flex-col gap-1 border-t border-ink-100 dark:border-ink-800/60 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={COMPARISON_TONES[comparison]}>{t(COMPARISON_KEYS[comparison])}</Badge>
        <Badge tone="neutral">{t(VALIDATION_KEYS[occurrence.validation])}</Badge>
        <span className="text-[11px] text-ink-500 dark:text-ink-400">
          {t('webscanFindingConfidence')}: {t(CONFIDENCE_KEYS[occurrence.confidence])}
        </span>
        {exception && <Badge tone="brand">{t('webscanFindingExcepted')}</Badge>}
      </div>
      <p className="text-[11px] text-ink-700 dark:text-ink-200 break-all" dir="ltr">
        {occurrence.safeLocation}
      </p>
      {exception && (
        <p className="text-[11px] text-ink-500 dark:text-ink-400">
          {t('webscanFindingException')}: {t(EXCEPTION_KIND_KEYS[exception.kind])} ·{' '}
          {exception.expiresAt === null
            ? t('webscanExceptionNoExpiry')
            : t('webscanExceptionExpiresAt', { date: formatDateTime(exception.expiresAt, language) })}
        </p>
      )}
    </li>
  );
}

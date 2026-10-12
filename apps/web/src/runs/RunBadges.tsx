import type { ReviewRun, SeverityCounts } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';

export function RunProviderBadge({ provider }: { provider?: string | null | undefined }) {
  if (!provider) {
    return <span className="text-ink-400 dark:text-ink-500">—</span>;
  }

  const normalized = provider.toLowerCase();
  let colorClass = 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300';
  let label = provider;

  if (normalized.includes('anthropic') || normalized.includes('claude')) {
    colorClass = 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300';
    label = 'Anthropic';
  } else if (normalized.includes('openai') || normalized.includes('gpt')) {
    colorClass = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300';
    label = 'OpenAI';
  } else if (normalized.includes('gemini') || normalized.includes('google')) {
    colorClass = 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300';
    label = 'Gemini';
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide ${colorClass}`}
    >
      {label}
    </span>
  );
}

export function RunModelBadge({
  model,
  effort,
  fallbackFrom,
}: {
  model?: string | null | undefined;
  effort?: string | null | undefined;
  fallbackFrom?: string | null | undefined;
}) {
  const { t } = useI18n();

  if (!model) {
    return <span className="text-ink-400 dark:text-ink-500">—</span>;
  }

  const fallbackTooltip = fallbackFrom
    ? t('fallbackFromTooltip').replace('{from}', fallbackFrom)
    : '';

  return (
    <div className="inline-flex items-center gap-1 flex-wrap max-w-[8.5rem]">
      <span className="font-mono text-[11px] text-ink-900 dark:text-ink-100 font-medium truncate max-w-[8rem]" dir="ltr" title={model}>
        {model}
      </span>
      {effort && (
        <span
          className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-300"
          dir="ltr"
        >
          {effort}
        </span>
      )}
      {fallbackFrom && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 cursor-help"
          title={fallbackTooltip}
          aria-label={fallbackTooltip}
        >
          {t('fallbackBadge')}
        </span>
      )}
    </div>
  );
}

export function RunSeverityChips({
  status,
  findingsCount,
  severityCounts,
  detail,
}: {
  status: ReviewRun['status'];
  findingsCount?: number | null | undefined;
  severityCounts?: SeverityCounts | null | undefined;
  detail?: string | null | undefined;
}) {
  const { t } = useI18n();

  if (status === 'failed') {
    const errorMsg = getFailedRunMessage(detail, t);
    return (
      <span
        className="inline-block text-[11px] text-red-600 dark:text-red-400 truncate max-w-[120px]"
        title={detail || errorMsg}
      >
        {errorMsg}
      </span>
    );
  }

  if (status === 'queued' || status === 'running') {
    return <span className="text-ink-400 dark:text-ink-500">—</span>;
  }

  const totalFindings =
    findingsCount ??
    (severityCounts
      ? severityCounts.critical +
        severityCounts.high +
        severityCounts.medium +
        severityCounts.low +
        severityCounts.info
      : 0);

  if (totalFindings === 0) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300">
        {t('noFindings')}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1 flex-wrap max-w-[120px]">
      {severityCounts && severityCounts.critical > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300"
          title={`${t('severityCritical')}: ${severityCounts.critical}`}
        >
          {severityCounts.critical} {t('severityCritical')}
        </span>
      )}
      {severityCounts && severityCounts.high > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300"
          title={`${t('severityHigh')}: ${severityCounts.high}`}
        >
          {severityCounts.high} {t('severityHigh')}
        </span>
      )}
      {severityCounts && severityCounts.medium > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
          title={`${t('severityMedium')}: ${severityCounts.medium}`}
        >
          {severityCounts.medium} {t('severityMedium')}
        </span>
      )}
      {severityCounts && severityCounts.low > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
          title={`${t('severityLow')}: ${severityCounts.low}`}
        >
          {severityCounts.low} {t('severityLow')}
        </span>
      )}
      {(!severityCounts ||
        (severityCounts.critical === 0 &&
          severityCounts.high === 0 &&
          severityCounts.medium === 0 &&
          severityCounts.low === 0)) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300">
          {totalFindings}
        </span>
      )}
    </div>
  );
}

function getFailedRunMessage(
  detail: string | null | undefined,
  t: (key: I18nKey) => string,
): string {
  if (!detail) return t('errorUnknown');
  const d = detail.toLowerCase();
  if (d.includes('quota')) return t('errorQuota');
  if (d.includes('rate-limit') || d.includes('rate limit')) return t('errorRateLimit');
  if (d.includes('server')) return t('errorServer');
  if (d.includes('auth')) return t('errorAuth');
  if (d.includes('invalid-response')) return t('errorInvalidResponse');
  if (d.includes('interrupted')) return t('errorInterrupted');
  return detail;
}

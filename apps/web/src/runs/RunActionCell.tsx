import { RotateCcw } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import type { ReviewRun } from '../api/client.js';

interface RunActionCellProps {
  run: ReviewRun;
  isMember: boolean;
  onRetry: (runId: string) => void;
  isRetrying: boolean;
}

export function RunActionCell({
  run,
  isMember,
  onRetry,
  isRetrying,
}: RunActionCellProps) {
  const { t } = useI18n();

  const isEligible = run.status === 'failed' || run.status === 'skipped';
  if (!isEligible) {
    return <span className="text-ink-300 dark:text-ink-600 select-none">—</span>;
  }

  const tooltip = isMember ? t('retryMemberDisabled') : t('retry');

  return (
    <button
      type="button"
      disabled={isMember || isRetrying}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(run.id);
      }}
      title={tooltip}
      aria-label={t('retry')}
      className={`inline-flex items-center justify-center p-1.5 rounded-md transition-colors ${
        isMember
          ? 'opacity-40 cursor-not-allowed text-ink-400 dark:text-ink-500'
          : 'text-ink-600 dark:text-ink-300 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-ink-100 dark:hover:bg-ink-800'
      }`}
    >
      <RotateCcw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
    </button>
  );
}

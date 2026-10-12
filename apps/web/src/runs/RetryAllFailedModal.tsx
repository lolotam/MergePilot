import { RefreshCw, AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

interface RetryAllFailedModalProps {
  isOpen: boolean;
  count: number;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RetryAllFailedModal({
  isOpen,
  count,
  isLoading,
  onClose,
  onConfirm,
}: RetryAllFailedModalProps) {
  const { t } = useI18n();

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="retry-all-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-950/50 backdrop-blur-xs"
    >
      <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-lg max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-100">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h2 id="retry-all-title" className="text-sm font-bold text-ink-900 dark:text-ink-100">
              {t('retryAllFailedConfirmTitle')}
            </h2>
            <p className="text-xs text-ink-600 dark:text-ink-400 mt-1.5 leading-relaxed">
              {t('retryAllFailedConfirmDesc').replace('{count}', String(count))}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 mt-2 pt-3 border-t border-ink-100 dark:border-ink-800">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-md border border-ink-200 dark:border-ink-700 text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white shadow-xs transition-colors disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{t('retrying')}</span>
              </>
            ) : (
              <span>{t('retryAllFailed')}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

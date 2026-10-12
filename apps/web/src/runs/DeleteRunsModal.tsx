import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

/** Above this many runs the user must type the confirm word. */
export const TYPE_TO_CONFIRM_ABOVE = 100;

interface DeleteRunsModalProps {
  isOpen: boolean;
  count: number;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteRunsModal({ isOpen, count, isLoading, onClose, onConfirm }: DeleteRunsModalProps) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isLoading, onClose]);

  if (!isOpen) return null;
  const word = t('deleteRunsConfirmWord');
  const mustType = count > TYPE_TO_CONFIRM_ABOVE;
  const canConfirm = !isLoading && count > 0 && (!mustType || typed.trim() === word);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-runs-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-950/50 backdrop-blur-xs"
    >
      <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-lg max-w-md w-full p-6 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-full bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="delete-runs-title" className="text-sm font-bold text-ink-900 dark:text-ink-100">
              {t('deleteRunsTitle')}
            </h2>
            <p className="text-xs text-ink-700 dark:text-ink-300 mt-1.5">{t('deleteRunsDesc', { n: count })}</p>
            <p className="text-xs text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">{t('deleteRunsKeepNote')}</p>
            {mustType ? (
              <label className="flex flex-col gap-1.5 mt-3 text-xs text-ink-700 dark:text-ink-300">
                <span>{t('deleteRunsTypeToConfirm', { word })}</span>
                <input
                  type="text"
                  value={typed}
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                  className="px-3 py-1.5 rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:outline-hidden focus:ring-2 focus:ring-red-500"
                />
              </label>
            ) : null}
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
            disabled={!canConfirm}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 text-white shadow-xs transition-colors disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            <span>{isLoading ? t('deletingRuns') : t('deleteRunsButton')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

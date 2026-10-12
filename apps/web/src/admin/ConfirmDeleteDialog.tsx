import { useEffect, useId, useState } from 'react';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/context.js';

export interface ConfirmDeleteDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** When set, the delete button stays disabled until this exact text is typed. */
  requiredText?: string;
  isPending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDeleteDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  requiredText,
  isPending = false,
  onConfirm,
  onClose,
}: ConfirmDeleteDialogProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (isOpen) setTyped('');
  }, [isOpen]);

  const canConfirm = !isPending && (requiredText === undefined || typed.trim() === requiredText.trim());

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} description={description}>
      <form
        className="flex flex-col gap-4 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) onConfirm();
        }}
      >
        {requiredText !== undefined && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
              {t('typeWorkspaceNameToConfirm')}
              <span className="ms-1 font-mono font-bold text-red-600 dark:text-red-400">{requiredText}</span>
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full px-3.5 py-2 text-xs rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-950 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            />
          </div>
        )}
        <div className="flex justify-end gap-2.5 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className="px-5 py-2 text-xs font-semibold rounded-full bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {isPending ? t('loading') : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '../../components/Modal.js';
import { useI18n } from '../../i18n/context.js';

/**
 * The confirmation dialog of the website scan panels.
 *
 * The shared modal does not move the focus, so the dialog does it here: the
 * confirm button takes the focus when the dialog opens, and the keyboard can
 * reach the whole form from there.
 */
export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  /** The body of the dialog: the list the administrator confirms. */
  children?: ReactNode;
  confirmLabel: string;
  isPending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  children,
  confirmLabel,
  isPending = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) confirmRef.current?.focus();
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} description={description ?? ''}>
      <form
        className="flex flex-col gap-4 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isPending) onConfirm();
        }}
      >
        {children}
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-700 dark:text-ink-300 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            disabled={isPending}
            className="px-5 py-2 text-xs font-semibold rounded-full bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {isPending ? t('loading') : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

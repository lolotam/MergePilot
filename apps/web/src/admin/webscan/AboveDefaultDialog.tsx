import type { WebScanLimits } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { formatCount } from '../format.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { WEB_SCAN_LIMIT_ROWS } from './limit-rows.js';
import { WEB_SCAN_LIMIT_SPECS } from './limits.js';

/**
 * The second confirmation of a limit above its default (ADR-0052 section 5).
 *
 * The dialog lists the values that are above their default, so the
 * administrator confirms exactly what the server is about to store.
 */
export interface AboveDefaultDialogProps {
  isOpen: boolean;
  /** The fields whose effective value is above its default. */
  fields: (keyof WebScanLimits)[];
  /** The effective limits the confirmation is bound to. */
  limits: WebScanLimits;
  isPending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function AboveDefaultDialog({
  isOpen,
  fields,
  limits,
  isPending = false,
  onConfirm,
  onClose,
}: AboveDefaultDialogProps) {
  const { t, language } = useI18n();

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={t('webscanConfirmAboveDefaultTitle')}
      description={t('webscanConfirmAboveDefaultDesc')}
      confirmLabel={t('webscanConfirmAboveDefaultButton')}
      isPending={isPending}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <ul className="flex flex-col gap-1 text-xs text-ink-700 dark:text-ink-300">
        {fields.map((field) => {
          const row = WEB_SCAN_LIMIT_ROWS.find((entry) => entry.field === field);
          if (!row) return null;
          const spec = WEB_SCAN_LIMIT_SPECS[field];
          return (
            <li key={field}>
              {t('webscanConfirmAboveDefaultValue', {
                label: t(row.label),
                value: `${formatCount(limits[field], language)} ${t(row.unit)}`,
                default: `${formatCount(spec.default, language)} ${t(row.unit)}`,
              })}
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}

import { useI18n } from '../../i18n/context.js';
import { StateMessage } from '../ui.js';

/**
 * The empty state of the sections that the next delivery step fills.
 *
 * The scan results, the exceptions and the audit log arrive with their own
 * panels; until then the section shows a neutral empty state instead of a
 * broken one.
 */
export function PanelNotReady() {
  const { t } = useI18n();

  return (
    <div className="bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <StateMessage>
        <p className="font-semibold text-ink-700 dark:text-ink-300">{t('webscanPanelNotReady')}</p>
        <p className="mt-1">{t('webscanPanelNotReadyDesc')}</p>
      </StateMessage>
    </div>
  );
}

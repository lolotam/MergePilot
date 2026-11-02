import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { StateMessage } from '../ui.js';

/** The shared states of the website scan panels (ADR-0052 section 12). */

/**
 * The panel is still loading.
 *
 * The message is a live region: the screen reader says that the panel is
 * loading instead of leaving the administrator in silence.
 */
export function LoadingState() {
  const { t } = useI18n();
  return (
    <StateMessage>
      <span role="status">{t('loading')}</span>
    </StateMessage>
  );
}

/**
 * The server refused to answer.
 *
 * The message is an alert: the failure replaces the content of the panel, so
 * the screen reader has to say it.
 */
export function ErrorState() {
  const { t } = useI18n();
  return (
    <StateMessage>
      <span role="alert">{t('webscanLoadError')}</span>
    </StateMessage>
  );
}

/**
 * The session lost its platform-admin rights: the API answers every route of
 * the area with the regular 404, and there is nothing to retry.
 *
 * The message is an alert: the area is gone, and the screen reader has to say
 * it.
 */
export function PermissionLostState() {
  const { t } = useI18n();
  return (
    <StateMessage>
      <span role="alert">{t('webscanPermissionLost')}</span>
    </StateMessage>
  );
}

/** The area holds no row yet. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <StateMessage>{children}</StateMessage>;
}

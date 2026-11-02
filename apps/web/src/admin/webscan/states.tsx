import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { StateMessage } from '../ui.js';

/** The shared states of the website scan panels (ADR-0052 section 12). */

/** The panel is still loading. */
export function LoadingState() {
  const { t } = useI18n();
  return <StateMessage>{t('loading')}</StateMessage>;
}

/** The server refused to answer. */
export function ErrorState() {
  const { t } = useI18n();
  return <StateMessage>{t('webscanLoadError')}</StateMessage>;
}

/**
 * The session lost its platform-admin rights: the API answers every route of
 * the area with the regular 404, and there is nothing to retry.
 */
export function PermissionLostState() {
  const { t } = useI18n();
  return <StateMessage>{t('webscanPermissionLost')}</StateMessage>;
}

/** The area holds no row yet. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <StateMessage>{children}</StateMessage>;
}

import type { LiveState } from '../api/useRunsLive.js';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';

type ShownState = Exclude<LiveState, 'off'>;

const LABELS: Record<ShownState, I18nKey> = {
  live: 'liveIndicator',
  connecting: 'liveConnecting',
  polling: 'livePolling',
};

const DOTS: Record<ShownState, string> = {
  live: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  polling: 'bg-ink-400',
};

/** Small «Live» badge of the runs page and run detail (ADR-0021); hidden without live updates. */
export function LiveIndicator({ state }: { state: LiveState }) {
  const { t } = useI18n();
  if (state === 'off') return null;
  return (
    <span
      data-testid="live-indicator"
      data-state={state}
      role="status"
      title={t(LABELS[state])}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-ink-200 dark:border-ink-700 text-[11px] font-semibold text-ink-600 dark:text-ink-300"
    >
      <span className="relative inline-flex w-2 h-2">
        {state === 'live' ? <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping" /> : null}
        <span className={`relative inline-flex w-2 h-2 rounded-full ${DOTS[state]}`} />
      </span>
      <span>{t(LABELS[state])}</span>
    </span>
  );
}

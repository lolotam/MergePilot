import { useEffect, useState } from 'react';
import type { ReviewRun } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { elapsedMs, formatDurationMs, isActiveRun, runDurationMs } from './run-duration.js';

const TICK_MS = 1000;

/** The current time, refreshed every second while `active`; no timer runs otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

type DurationRun = Pick<ReviewRun, 'status' | 'createdAt' | 'finishedAt' | 'durationMs'>;

/**
 * A run's duration. A queued or running run shows a live elapsed timer (ticking only while this
 * cell is mounted, i.e. its row is visible) in a subtle "running" style; unknown shows "—".
 */
export function RunDuration({ run }: { run: DurationRun }) {
  const { t, language } = useI18n();
  const active = isActiveRun(run);
  const now = useNow(active);

  if (!active) {
    return <span>{formatDurationMs(runDurationMs(run), language, t)}</span>;
  }
  return (
    <span
      data-testid="run-duration-live"
      title={t('durationRunning')}
      className="inline-flex items-center gap-1.5 text-brand-700 dark:text-brand-300"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" aria-hidden="true" />
      <span>{formatDurationMs(elapsedMs(run.createdAt, now), language, t)}</span>
    </span>
  );
}

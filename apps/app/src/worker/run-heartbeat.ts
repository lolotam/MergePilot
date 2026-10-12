import type { AppStore } from '../core/types.js';

/** How often the worker refreshes a running review's heartbeat (`review_runs.updated_at`). */
export const RUN_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface RunHeartbeatOptions {
  intervalMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
  logger?: import('pino').Logger | undefined;
}

/**
 * Touches the run every `intervalMs` while a review is in progress, so the stale-run sweep only
 * fails runs whose worker really stopped. Returns a stop function; call it in a `finally`.
 */
export function startRunHeartbeat(
  store: AppStore,
  workspaceId: string,
  runId: string,
  options: RunHeartbeatOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    store.touchReviewRun(workspaceId, runId).catch((error: unknown) => {
      // Only the error name: a driver message could echo connection details.
      const name = error instanceof Error ? error.name : 'unknown error';
      options.log?.(`Heartbeat for review run ${runId} failed: ${name}`);
      options.logger?.warn(
        { event: 'run.heartbeat_failed', runId, workspaceId, errName: name },
        `Heartbeat for review run ${runId} failed: ${name}`,
      );
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

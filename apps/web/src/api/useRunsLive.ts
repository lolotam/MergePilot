import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Events that arrive this close together trigger one refetch. */
export const LIVE_DEBOUNCE_MS = 300;
/** How long the stream may stay down before the page polls instead. */
export const LIVE_DOWN_FALLBACK_MS = 30_000;
/** The poll interval while the stream is down, and the retry delay once the browser gave up. */
export const LIVE_FALLBACK_POLL_MS = 30_000;

/**
 * `live`: the stream is open. `connecting`: (re)connecting. `polling`: down for 30 s, refetching
 * every 30 s. `off`: the browser has no EventSource; the page keeps its usual refetching.
 */
export type LiveState = 'connecting' | 'live' | 'polling' | 'off';

export interface RunsLiveOptions {
  /** On a run's detail page: react only to that run's events, and refetch only that run. */
  runId?: string | undefined;
}

interface RunEventData {
  runId?: unknown;
}

export function runEventsUrl(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/events`;
}

/**
 * Live run updates (ADR-0021). While mounted, listens to the workspace's run events over
 * Server-Sent Events and, on each one, invalidates the runs queries (debounced) so the table and
 * the detail page refetch; rows are never patched by hand. The browser's EventSource reconnects by
 * itself; when the stream stays down for more than 30 s, the queries are refetched every 30 s
 * until it is back.
 */
export function useRunsLive(workspaceId: string, options: RunsLiveOptions = {}): LiveState {
  const queryClient = useQueryClient();
  const { runId } = options;
  const [state, setState] = useState<LiveState>(() => (typeof EventSource === 'undefined' ? 'off' : 'connecting'));

  useEffect(() => {
    if (!workspaceId || typeof EventSource === 'undefined') return undefined;
    const queryKey = runId ? ['workspaces', workspaceId, 'runs', runId] : ['workspaces', workspaceId, 'runs'];
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey });
    };

    let source: EventSource | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let downTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const startPolling = () => {
      if (poll) return;
      setState('polling');
      refetch();
      poll = setInterval(refetch, LIVE_FALLBACK_POLL_MS);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };
    const markDown = () => {
      if (downTimer || poll) return;
      downTimer = setTimeout(() => {
        downTimer = undefined;
        startPolling();
      }, LIVE_DOWN_FALLBACK_MS);
    };

    const onRun = (message: MessageEvent<string>) => {
      if (runId) {
        let data: RunEventData;
        try {
          data = JSON.parse(message.data) as RunEventData;
        } catch {
          return;
        }
        if (data.runId !== runId) return;
      }
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        refetch();
      }, LIVE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(runEventsUrl(workspaceId), { withCredentials: true });
      source = es;
      es.addEventListener('run', onRun as EventListener);
      es.onopen = () => {
        if (downTimer) clearTimeout(downTimer);
        downTimer = undefined;
        const wasDown = Boolean(poll);
        stopPolling();
        setState('live');
        // Changes made while the stream was down are not replayed; catch up once.
        if (wasDown) refetch();
      };
      es.onerror = () => {
        setState((s) => (s === 'polling' ? s : 'connecting'));
        markDown();
        // A closed source (e.g. 401/429/503 answers) is never retried by the browser: retry later.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          if (!reopen) {
            reopen = setTimeout(() => {
              reopen = undefined;
              connect();
            }, LIVE_FALLBACK_POLL_MS);
          }
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      source?.close();
      for (const t of [debounce, downTimer, reopen]) if (t) clearTimeout(t);
      stopPolling();
    };
  }, [workspaceId, runId, queryClient]);

  return state;
}

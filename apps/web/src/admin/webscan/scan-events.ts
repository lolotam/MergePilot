import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WebScanScanStatus } from '@mergepilot/app/contract';
import { webScanScanKey } from './hooks.js';

/**
 * The live progress of a scan (ADR-0052 section 7, ADR-0021 shape).
 *
 * The stream is the same shape as the live run updates: the browser's
 * EventSource reconnects by itself and the session cookie authenticates the
 * stream. The counters of an event are the live view of the scan, never its
 * result: the panel refetches the state of the scan whenever the status of
 * the stream changes and on every open and on every error, so a missed event
 * can never leave a stale number on the page.
 */

/** The counters of one progress event. */
export interface ScanProgress {
  status: WebScanScanStatus;
  requests: number;
  pages: number;
  elapsedMs: number;
}

/** The stream of one scan. */
export function scanEventsUrl(scanId: string): string {
  return `/api/admin/web-scan/scans/${encodeURIComponent(scanId)}/events`;
}

/**
 * The progress of a stream event, when the event carries one.
 *
 * The payload is checked here and not by a schema: the browser bundle carries
 * no validator, and a stream that sends something else is ignored instead of
 * reaching the page.
 */
export function toScanProgress(value: unknown): ScanProgress | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Record<string, unknown>;
  const { status, requests, pages, elapsedMs } = event;
  if (
    typeof status !== 'string' ||
    typeof requests !== 'number' ||
    typeof pages !== 'number' ||
    typeof elapsedMs !== 'number'
  ) {
    return undefined;
  }
  if (!['queued', 'running', 'completed', 'stopped', 'failed'].includes(status)) return undefined;
  return { status: status as WebScanScanStatus, requests, pages, elapsedMs };
}

/**
 * Listens to the progress of one scan while the panel is mounted.
 *
 * The panel gives the live counters to `onProgress` and reads the durable
 * state from its own query, which is refetched whenever the status of the
 * stream changes and whenever the stream opens or drops.
 */
export function useScanEvents(
  scanId: string | undefined,
  onProgress: (progress: ScanProgress) => void,
): void {
  const queryClient = useQueryClient();
  const progressRef = useRef(onProgress);

  useEffect(() => {
    progressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    if (!scanId || typeof EventSource === 'undefined') return undefined;

    const source = new EventSource(scanEventsUrl(scanId), { withCredentials: true });
    // The status the stream reported last: a status that changed is a state
    // the server owns now, so the panel asks for it again.
    let lastStatus: WebScanScanStatus | undefined;
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: webScanScanKey(scanId) });
    };
    const refetchState = () => {
      refetch();
      void queryClient.invalidateQueries({ queryKey: ['webscan', 'scans'] });
    };
    const onScan = (message: Event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse((message as MessageEvent<string>).data);
      } catch {
        return;
      }
      const progress = toScanProgress(parsed);
      if (!progress) return;
      progressRef.current(progress);
      // A plain progress event of the same status carries no new state: the
      // scan is still the one the panel shows.
      if (progress.status === lastStatus) return;
      lastStatus = progress.status;
      refetchState();
    };

    source.addEventListener('scan', onScan as EventListener);
    // An open stream may have missed events: the state comes from the server.
    // A stream that dropped while the scan finished leaves the history stale too.
    source.onopen = () => {
      refetchState();
    };
    source.onerror = () => {
      refetchState();
    };

    return () => {
      source.close();
    };
  }, [scanId, queryClient]);
}

import { ScanStopError, type ScanStopReason } from '@mergepilot/webscan';

/**
 * The abort of the scan that runs now (ADR-0052 section 7).
 *
 * The worker is the only place that runs a scan, so it is also the only place that may
 * stop one. A stop has exactly one owner: the controller below. Everything that can end
 * a run early - the loss of the advisory lease, the loss of the BullMQ job lock, an
 * explicit cancel and the shutdown of the process - aborts that one controller, and the
 * first reason wins.
 *
 * The abort carries a typed `ScanStopError`. The package then stops the scan instead of
 * failing it, and the observations of the pages that were already read survive the stop
 * as a partial result.
 */

/** Why the worker aborted the scan. */
export type WebScanAbortReason =
  /** The dedicated connection of the advisory lease was lost. */
  | 'lease_lost'
  /** The BullMQ job lock of the running job was lost. */
  | 'job_lock_lost'
  /** The scan was cancelled on purpose. */
  | 'cancelled'
  /** The process is shutting down. */
  | 'shutdown';

/**
 * The reason of the package an abort maps to.
 *
 * The package of the scanner knows a fixed set of stop reasons. A worker that loses the
 * ownership of the running scan - the advisory lease or the BullMQ job lock - has lost
 * the right to run it, and the package reports that as `lease_lost`. A cancel and a
 * shutdown are a cancellation. The precise reason of the worker is kept next to it, in
 * the `stop_reason` column of the scan, so nothing is lost.
 */
export function packageStopReason(reason: WebScanAbortReason): ScanStopReason {
  switch (reason) {
    case 'lease_lost':
    case 'job_lock_lost':
      return 'lease_lost';
    case 'cancelled':
    case 'shutdown':
      return 'cancelled';
  }
}

/** The message of an abort. It never carries a hostname, a target or a credential. */
const ABORT_MESSAGES: Record<WebScanAbortReason, string> = {
  lease_lost: 'The scan lost the lease that lets it run.',
  job_lock_lost: 'The scan lost the job lock that lets it run.',
  cancelled: 'The scan was cancelled.',
  shutdown: 'The scan was stopped because the process is shutting down.',
};

/** The controller that owns the abort of one run. */
export interface WebScanAbortController {
  /** The signal the package of the scan observes. */
  readonly signal: AbortSignal;
  /** The reason of the abort, or undefined while the run may continue. */
  readonly reason: WebScanAbortReason | undefined;
  /** Whether the run was aborted. */
  readonly aborted: boolean;
  /** Aborts the run. The first reason wins. */
  abort(reason: WebScanAbortReason): void;
}

/** Creates the controller of one run. */
export function createScanAbortController(): WebScanAbortController {
  const controller = new AbortController();
  let reason: WebScanAbortReason | undefined;
  return {
    signal: controller.signal,
    get reason(): WebScanAbortReason | undefined {
      return reason;
    },
    get aborted(): boolean {
      return reason !== undefined;
    },
    abort(next: WebScanAbortReason): void {
      if (reason !== undefined) return;
      reason = next;
      controller.abort(new ScanStopError(packageStopReason(next), ABORT_MESSAGES[next]));
    },
  };
}

/**
 * The registry of the run that runs now.
 *
 * The runtime keeps one registry and hands the controller of the run to the worker. A
 * cancel, a shutdown or a lost job lock aborts the run through the registry, so the
 * owner of the run never has to know how the run is implemented.
 */
export class WebScanAbortRegistry {
  private current: { controller: WebScanAbortController; scanId: string } | undefined;
  private closed = false;

  /** Whether the registry refuses new runs. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** The scan id of the run that runs now. */
  get currentScanId(): string | undefined {
    return this.current?.scanId;
  }

  /** Registers the run that starts now and returns its controller. */
  begin(scanId: string): WebScanAbortController {
    const controller = createScanAbortController();
    if (this.closed) controller.abort('shutdown');
    this.current = { controller, scanId };
    return controller;
  }

  /** Forgets the run that ended. */
  end(controller: WebScanAbortController): void {
    if (this.current?.controller === controller) this.current = undefined;
  }

  /**
   * Aborts the run that runs now.
   *
   * Returns false when no run was running: the caller then knows that nothing was
   * stopped and that a queued scan has to be stopped in the database instead.
   */
  abort(reason: WebScanAbortReason): boolean {
    const current = this.current;
    if (current === undefined) return false;
    current.controller.abort(reason);
    return true;
  }

  /**
   * Aborts the run of one scan.
   *
   * Returns false when the scan does not run in this process, so the caller knows that
   * the cancel has to reach the process that owns it.
   */
  abortScan(scanId: string, reason: WebScanAbortReason): boolean {
    const current = this.current;
    if (current === undefined || current.scanId !== scanId) return false;
    current.controller.abort(reason);
    return true;
  }

  /** Aborts the run and refuses every later run. */
  shutdown(): boolean {
    this.closed = true;
    return this.abort('shutdown');
  }
}

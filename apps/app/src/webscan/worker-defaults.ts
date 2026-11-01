import { runScan, type ScanDependencies, type ScanInput, type ScanObservation } from '@mergepilot/webscan';
import { createGuardedScanFetch, type GuardedScanFetch } from './guarded-fetch.js';

/**
 * The defaults of the scan worker.
 *
 * They are the real implementations of the package and of the guarded transport. The
 * worker takes them as injectable dependencies so a test can replace them, but the
 * production path always uses these.
 */

/** The scan runner of the package. */
export async function defaultRunScan(
  input: ScanInput,
  scanDeps: ScanDependencies,
): Promise<ScanObservation> {
  return runScan(input, scanDeps);
}

/** The guarded transport of the app: the SSRF policy, the deadlines and the limits. */
export function defaultFetchFactory(options: {
  hostname: string;
  contact: string;
  maxResponseBytes: number;
}): GuardedScanFetch {
  return createGuardedScanFetch({
    hostname: options.hostname,
    contact: options.contact,
    maxResponseBytes: options.maxResponseBytes,
  });
}

/** Waits for the given number of milliseconds, or until the signal aborts. */
export function sleepWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Bounded attempts (ADR-0052 section 2).
 *
 * One attempt of the scanner is one outbound request and the reading of its
 * body. Both are bounded by the same deadline, and both end when the scan is
 * cancelled — even when the injected transport ignores the abort signal.
 *
 * The helper here owns three things:
 *
 * - A derived signal. The transport never sees the signal of the whole scan;
 *   it sees the signal of the attempt, which the scan can end at any moment.
 * - A real timer. The deadline has to fire even when the injected clock of a
 *   test stands still, so the timer is a real one and it is always disposed.
 * - A race. A promise that ignores the signal is still settled by the abort,
 *   so a hung request cannot hold the worker.
 */

import { ScanStopError } from './errors.js';

/** One bounded attempt. */
export interface ScanAttempt {
  /** The signal of this attempt. It is aborted when the attempt ends. */
  readonly signal: AbortSignal;
  /** Releases the timer and the listeners of the attempt. */
  readonly dispose: () => void;
}

/** How an attempt is bounded. */
export interface ScanAttemptOptions {
  /** The signal of the whole operation. Its abort ends the attempt. */
  readonly outer: AbortSignal;
  /** How long the attempt may take, in milliseconds. */
  readonly timeoutMs: number;
  /** The error that ends the attempt when its own timeout expires. */
  readonly timeoutError: () => Error;
}

/**
 * The error an aborted signal carries.
 *
 * A signal that was aborted without a reason carries the abort of the platform;
 * the scan reports that as a cancellation.
 */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new ScanStopError('cancelled', 'The scan was cancelled.');
}

/**
 * Creates one bounded attempt.
 *
 * The caller disposes the attempt on every path — success, failure, retry and
 * cancellation — so no timer and no listener outlives it.
 */
export function createAttempt(options: ScanAttemptOptions): ScanAttempt {
  const controller = new AbortController();
  const disposers: Array<() => void> = [];
  if (options.outer.aborted) {
    controller.abort(options.outer.reason);
  } else {
    const onAbort = (): void => controller.abort(options.outer.reason);
    options.outer.addEventListener('abort', onAbort, { once: true });
    disposers.push(() => options.outer.removeEventListener('abort', onAbort));
  }
  const timer = setTimeout(() => controller.abort(options.timeoutError()), Math.max(options.timeoutMs, 0));
  disposers.push(() => clearTimeout(timer));
  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}

/**
 * Settles a promise, or the abort of a signal — whichever happens first.
 *
 * The promise keeps its own handlers attached, so a rejection that arrives
 * after the abort is handled and never becomes an unhandled rejection.
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

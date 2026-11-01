import type { Pool, PoolClient } from 'pg';

/**
 * The global scan lease (ADR-0052 section 7).
 *
 * Every web-scan worker shares one PostgreSQL advisory lock. The lock is taken on a
 * dedicated connection and is held for the whole lifetime of the scan, so a rolling
 * deployment or a stalled job can never produce two scans at the same time. The lock
 * is released in a `finally` block, and the loss of the dedicated connection ends the
 * scan: no further request may leave the process after it.
 *
 * The lease never carries a target, a hostname or a credential; it only knows the
 * lock key and the health of its connection.
 */

/**
 * The advisory lock key of the scanner.
 *
 * It is a fixed 64-bit integer, written as text so the parameter never depends on how
 * a driver serializes a JavaScript big integer. It must never change: a changed key
 * would let two workers hold two different locks.
 */
export const WEB_SCAN_LEASE_KEY = '715694339021884417';

/** Why a lease could not be established or was lost. */
export type WebScanLeaseErrorCode = 'lease_unavailable' | 'lease_connection_lost';

/** A lease failure. */
export class WebScanLeaseError extends Error {
  readonly code: WebScanLeaseErrorCode;

  constructor(code: WebScanLeaseErrorCode, message: string) {
    super(message);
    this.name = 'WebScanLeaseError';
    this.code = code;
  }
}

/** A held scan lease. */
export interface ScanLease {
  /** The dedicated connection that holds the advisory lock. */
  readonly connection: PoolClient;
  /** Whether the dedicated connection is still usable. */
  isAlive(): boolean;
  /** Releases the lock and returns the connection to the pool. Safe to call twice. */
  release(): Promise<void>;
}

/** The options of {@link acquireScanLease}. */
export interface AcquireScanLeaseOptions {
  /** The pool the dedicated connection is taken from. */
  pool: Pool;
  /** The advisory lock key. Defaults to {@link WEB_SCAN_LEASE_KEY}. */
  key?: string | undefined;
  /** How long to wait for the lock. Defaults to no wait at all. */
  waitMs?: number | undefined;
  /** How long to wait between two attempts while the lock is held elsewhere. */
  retryMs?: number | undefined;
  /** Called with the error name when the dedicated connection is lost. */
  onConnectionLost?: ((errorName: string) => void) | undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Takes the global scan lease.
 *
 * The lock is taken with a bounded try-lock loop, so a caller never blocks forever
 * behind another worker. When the lock cannot be taken the lease is not established
 * and the caller decides whether the scan waits or is deferred.
 */
export async function acquireScanLease(options: AcquireScanLeaseOptions): Promise<ScanLease> {
  const key = options.key ?? WEB_SCAN_LEASE_KEY;
  const waitMs = options.waitMs ?? 0;
  const retryMs = options.retryMs ?? 100;

  const connection = await options.pool.connect();
  let broken = false;
  let released = false;

  const onError = (error: unknown): void => {
    broken = true;
    options.onConnectionLost?.(errorName(error));
  };
  connection.on('error', onError);

  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    let locked: boolean;
    try {
      const result = await connection.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key],
      );
      locked = result.rows[0]?.locked === true;
    } catch (error) {
      broken = true;
      connection.removeListener('error', onError);
      connection.release(new Error(`scan lease query failed: ${errorName(error)}`));
      throw new WebScanLeaseError(
        'lease_connection_lost',
        'The scan lease connection failed before the lock was taken.',
      );
    }

    if (locked) break;
    if (Date.now() >= deadline) {
      connection.removeListener('error', onError);
      connection.release();
      throw new WebScanLeaseError(
        'lease_unavailable',
        'The scan lease is held by another worker.',
      );
    }
    await delay(retryMs);
  }

  return {
    connection,
    isAlive: () => !broken,
    release: async () => {
      if (released) return;
      released = true;
      connection.removeListener('error', onError);
      try {
        if (!broken) {
          await connection.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
        }
      } catch {
        // The connection is gone; the lock died with the session.
      } finally {
        // A broken connection must never go back into the pool.
        connection.release(broken ? new Error('scan lease connection lost') : undefined);
      }
    },
  };
}

/** Waits for the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

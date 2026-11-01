import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { acquireScanLease, WEB_SCAN_LEASE_KEY, WebScanLeaseError } from './lease.js';

/**
 * The global scan lease (ADR-0052 section 7).
 *
 * The lease is a PostgreSQL advisory lock on a dedicated connection. It is held for the
 * whole run of a scan, so two workers never scan at the same time, and the loss of the
 * connection ends the scan.
 */

interface FakePool {
  pool: Pool;
  queries: { sql: string; params: unknown[] }[];
  released: { error: unknown }[];
  locked: boolean;
  /** Simulates the driver reporting a broken connection. */
  breakConnection: () => void;
}

function fakePool(options: { locked?: boolean } = {}): FakePool {
  const state: FakePool = {
    pool: undefined as unknown as Pool,
    queries: [],
    released: [],
    locked: options.locked ?? true,
    breakConnection: () => {},
  };
  const listeners: ((error: unknown) => void)[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      state.queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: state.locked }] };
      }
      return { rows: [] };
    },
    on: (_event: string, listener: (error: unknown) => void) => {
      listeners.push(listener);
      return client;
    },
    removeListener: (_event: string, listener: (error: unknown) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      return client;
    },
    release: (error?: unknown) => {
      state.released.push({ error });
    },
  };
  state.breakConnection = () => {
    for (const listener of [...listeners]) listener(new Error('connection terminated'));
  };
  state.pool = { connect: async () => client } as unknown as Pool;
  return state;
}

describe('the scan lease', () => {
  it('takes the advisory lock on a dedicated connection', async () => {
    const f = fakePool();

    const lease = await acquireScanLease({ pool: f.pool });

    expect(f.queries[0]?.sql).toContain('pg_try_advisory_lock');
    expect(f.queries[0]?.params).toEqual([WEB_SCAN_LEASE_KEY]);
    expect(lease.isAlive()).toBe(true);

    await lease.release();

    expect(f.queries[1]?.sql).toContain('pg_advisory_unlock');
    expect(f.queries[1]?.params).toEqual([WEB_SCAN_LEASE_KEY]);
    expect(f.released).toHaveLength(1);
    expect(f.released[0]?.error).toBeUndefined();
  });

  it('refuses the scan when another worker holds the lock', async () => {
    const f = fakePool({ locked: false });

    await expect(acquireScanLease({ pool: f.pool })).rejects.toBeInstanceOf(WebScanLeaseError);
    // The connection goes back to the pool; it does not hold a lock.
    expect(f.released).toHaveLength(1);
  });

  it('marks the lease dead when the dedicated connection is lost', async () => {
    const f = fakePool();
    let lostName: string | undefined;

    const lease = await acquireScanLease({
      pool: f.pool,
      onConnectionLost: (errorName) => {
        lostName = errorName;
      },
    });

    f.breakConnection();

    expect(lease.isAlive()).toBe(false);
    expect(lostName).toBe('Error');

    await lease.release();

    // The unlock is not attempted on a dead connection, and the connection is not
    // returned to the pool.
    expect(f.queries.some((query) => query.sql.includes('pg_advisory_unlock'))).toBe(false);
    expect(f.released[0]?.error).toBeInstanceOf(Error);
  });

  it('releases the lease only once', async () => {
    const f = fakePool();

    const lease = await acquireScanLease({ pool: f.pool });
    await lease.release();
    await lease.release();

    expect(f.released).toHaveLength(1);
  });
});

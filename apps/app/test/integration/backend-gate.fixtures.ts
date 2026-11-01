import { randomBytes } from 'node:crypto';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../src/db/schema.js';
import { PgWebScanStore } from '../../src/webscan/pg-store.js';
import { PurposeScopedVault } from '../../src/vault/scoped-secrets.js';

/**
 * The fixtures of the backend gate (ADR-0052).
 *
 * The gate needs a second, independent connection to the same database: PGlite and a
 * single pooled client cannot show that a decision is taken from the committed state
 * and not from a cache of the writing process. `openIndependentConnection` opens a
 * separate session over the same schema, which is what a second process sees.
 */

/** The master key of the gate. It only seals the identity keys of the test sites. */
export const GATE_MASTER_KEY = randomBytes(32).toString('base64');

/** An independent connection to an existing test schema. */
export interface IndependentConnection {
  pool: Pool;
  store: PgWebScanStore;
  close: () => Promise<void>;
}

/**
 * Opens a separate session on an existing test schema.
 *
 * The caller owns the returned pool and closes it. Closing it simulates the process
 * that wrote the rows being gone, which is how the gate proves that a queued intent
 * is durable and not an artifact of a live transaction.
 */
export async function openIndependentConnection(
  connectionString: string,
  masterKey: string = GATE_MASTER_KEY,
): Promise<IndependentConnection> {
  const pool = new Pool({ connectionString });
  const db = drizzleNodePg(pool, { schema });
  const store = new PgWebScanStore(db, new PurposeScopedVault({ masterKey }));
  return {
    pool,
    store,
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * Resolves a promise, or rejects when it takes longer than the given time.
 *
 * The integration run must fail instead of hang when a queue never delivers.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

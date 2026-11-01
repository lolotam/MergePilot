/* global process, Buffer, Response, setInterval, clearInterval */
import { Worker } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createQueueConnection } from '../../../dist/queue/bullmq-queue.js';
import * as schema from '../../../dist/db/schema.js';
import { PgWebScanStore } from '../../../dist/webscan/pg-store.js';
import { PgWebScanWorkerStore } from '../../../dist/webscan/worker-store-persistence.js';
import { processScanJob } from '../../../dist/webscan/worker.js';
import { PurposeScopedVault } from '../../../dist/vault/scoped-secrets.js';

/**
 * A process that runs the production worker on one job and then holds the job.
 *
 * The process takes the job from the real queue, runs the production `processScanJob` on it
 * and parks the request of the fixture transport. The scan of the database is claimed by the
 * production claim, so the scan row is running while the job is held.
 *
 * The usage is:
 *
 *   node recovery-scan-worker.mjs <connectionString> <redisUrl> <scanId> <masterKey>
 *
 * The process prints `claimed` when the scan row of the database is running and `request`
 * when the fixture transport received the request. It never finishes on its own: the parent
 * process kills it, which is the crash of the proof.
 */

const [, , connectionString, redisUrl, scanId, masterKey] = process.argv;

if (connectionString === undefined || redisUrl === undefined || scanId === undefined) {
  process.stderr.write('recovery-scan-worker: the arguments are missing\n');
  process.exit(2);
}

/** Prints a line and waits until the line left the process. */
function say(line) {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
const store = new PgWebScanStore(db, new PurposeScopedVault({ masterKey: masterKey ?? '' }));
const workerStore = new PgWebScanWorkerStore(db);

// The store of the worker is the shared store plus the capability that opens the identity
// key of a site. The key of the site is not the subject of the proof, so it is a fixed key.
const workerStoreFacade = new Proxy(store, {
  get(target, property, receiver) {
    if (property === 'openSiteIdentityKey') {
      return async () => Buffer.alloc(32, 3).toString('base64');
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// The transport of the fixture. It parks every request, so the scan stays in flight until
// the process dies. It never opens a socket.
const fixtureFetch = async (url, init) => {
  await say(`request ${url}`);
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(init.signal.reason ?? new Error('the run was aborted'));
    if (init.signal.aborted) {
      onAbort();
      return;
    }
    init.signal.addEventListener('abort', onAbort, { once: true });
  });
  return new Response('<!doctype html><html><body>fixture</body></html>', { status: 200 });
};

const deps = {
  store: workerStoreFacade,
  workerStore,
  pool,
  platformAdmins: ['admin@example.com'],
  createFetch: () => fixtureFetch,
};

const worker = new Worker(
  'web-scan',
  async (job) => {
    const outcome = await processScanJob(job.data.scanId, deps);
    await say(`outcome ${outcome}`);
    return outcome;
  },
  {
    connection: createQueueConnection(redisUrl),
    concurrency: 1,
    // A short lock, so the lock of the job of the dead process is gone quickly.
    lockDuration: 1000,
    stalledInterval: 1000,
  },
);

worker.on('error', () => undefined);

// The parent process waits for this line: the scan of the database is claimed and running.
const watcher = setInterval(async () => {
  const scan = await store.getScan(scanId);
  if (scan !== null && scan.status === 'running') {
    clearInterval(watcher);
    await say('claimed');
  }
}, 100);

await new Promise(() => {});

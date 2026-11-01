/* global process */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createQueueConnection } from '../../../dist/queue/bullmq-queue.js';
import * as schema from '../../../dist/db/schema.js';
import { createWebScanQueue } from '../../../dist/webscan/queue.js';
import { dispatchOutbox } from '../../../dist/webscan/outbox.js';
import { PgWebScanWorkerStore } from '../../../dist/webscan/worker-store-persistence.js';

/**
 * A process that publishes the outbox records with the production dispatcher.
 *
 * The process is the restart of the worker that owns the outbox. It reads the committed
 * records of the database and publishes them into the queue of the app.
 *
 * The usage is:
 *
 *   node recovery-dispatcher.mjs <mode> <connectionString> <redisUrl>
 *
 * The modes are:
 *
 *   publish         publishes the pending records and prints `published <count>`.
 *   crash-before-ack  publishes the records and dies in the moment the dispatcher writes
 *                   the acknowledgement of the database. The job is in Redis, the
 *                   database does not know it. The death is abrupt: the process is killed
 *                   with SIGKILL, so no handler of the process runs.
 */

const [, , mode, connectionString, redisUrl] = process.argv;

if (mode === undefined || connectionString === undefined || redisUrl === undefined) {
  process.stderr.write('recovery-dispatcher: the arguments are missing\n');
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
const workerStore = new PgWebScanWorkerStore(db);

/**
 * The worker store that dies before the acknowledgement of the dispatcher.
 *
 * Every method but the acknowledgement is the method of the production store. The
 * acknowledgement is where the process dies, so the boundary of the proof is the boundary
 * between the publication into Redis and the acknowledgement in the database.
 */
const crashingWorkerStore = new Proxy(workerStore, {
  get(target, property, receiver) {
    if (property === 'markOutboxPublished') {
      return async () => {
        await say('pre-ack');
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const queue = createWebScanQueue({ connection: createQueueConnection(redisUrl) });

try {
  // The records are read in the session of this process, so the printout shows the
  // committed state of the database and not the state of a transaction of this process.
  const pending = await workerStore.listPendingOutboxScans(50);
  await say(`pending ${pending.length}`);
  const result = await dispatchOutbox({
    store: mode === 'crash-before-ack' ? crashingWorkerStore : workerStore,
    queue,
  });
  await say(`published ${result.published}`);
} catch (error) {
  await say(`failed ${error instanceof Error ? error.name : 'unknown'}`);
  await queue.close();
  await pool.end();
  process.exit(4);
}

await queue.close();
await pool.end();
process.exit(0);

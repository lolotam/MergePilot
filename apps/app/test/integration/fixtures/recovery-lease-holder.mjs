/* global process */
import { Pool } from 'pg';
import { acquireScanLease } from '../../../dist/webscan/lease.js';

/**
 * A process that takes the lease of the scanner with the production lease function.
 *
 * The lease is the advisory lock of Postgres, so two processes of this script prove that the
 * exclusion works between two operating system processes and not only between two
 * connections of one process.
 *
 * The usage is:
 *
 *   node recovery-lease-holder.mjs <role> <connectionString> [waitMs]
 *
 * The roles are:
 *
 *   holder     takes the lease, prints `locked`, holds it until the standard input closes
 *              or the process is signalled, releases it and prints `released`.
 *   contender  takes the lease once. It prints `locked` when it got the lease and
 *              `unavailable <code>` when the production lease refused it.
 */

const [, , role, connectionString, waitMs] = process.argv;

if (role === undefined || connectionString === undefined) {
  process.stderr.write('recovery-lease-holder: the arguments are missing\n');
  process.exit(2);
}

const pool = new Pool({ connectionString, max: 2 });

/** Prints a line the parent process waits for. */
function say(line) {
  process.stdout.write(`${line}\n`);
}

let lease;

try {
  lease = await acquireScanLease({
    pool,
    waitMs: waitMs === undefined ? 0 : Number(waitMs),
  });
} catch (error) {
  const code = error && typeof error.code === 'string' ? error.code : 'unknown';
  say(`unavailable ${code}`);
  await pool.end();
  process.exit(3);
}

say('locked');

if (role === 'contender') {
  // The contender holds the lease until the parent stops the process.
  await new Promise(() => {});
} else {
  // The holder releases the lease when the parent asks for it or when the process is
  // signalled. A killed process never releases it: the session of Postgres ends with the
  // process and the server releases the lock by itself.
  let releasing = false;
  const release = async () => {
    if (releasing) return;
    releasing = true;
    await lease.release();
    say('released');
    await pool.end();
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (chunk.includes('release')) void release();
  });
  process.stdin.on('end', () => void release());
  process.on('SIGTERM', () => void release());
  process.on('SIGINT', () => void release());
  await new Promise(() => {});
}

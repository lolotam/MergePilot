import type { AppStore, MaintenanceRun } from '../core/types.js';

/** Runs deleted per statement; the loop repeats until a batch comes back short. */
export const RETENTION_BATCH_SIZE = 1000;
/** Pause between batches so a large cleanup does not hog the database. */
export const RETENTION_BATCH_PAUSE_MS = 200;
/** An unfinished retention run older than this is treated as crashed and its lease is taken over. */
export const RETENTION_LEASE_STALE_MS = 2 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

/** The part of a pino / Fastify logger the job uses. */
export interface RetentionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RetentionOptions {
  now?: () => Date;
  batchSize?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: RetentionLogger | undefined;
}

export interface RetentionResult {
  runId: string;
  workspaces: number;
  deleted: number;
  error: string | null;
}

/** A taken lease: the recorded maintenance run and the cleanup to execute under it. */
export interface RetentionLease {
  run: MaintenanceRun;
  execute: () => Promise<RetentionResult>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Error text for the maintenance log: name and message only, never a stack, capped. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Takes the retention lease (one unfinished run at a time across all workers and the admin "run
 * now"). Returns null when another cleanup holds it.
 */
export async function startRetention(store: AppStore, options: RetentionOptions = {}): Promise<RetentionLease | null> {
  const now = options.now ?? (() => new Date());
  const run = await store.startMaintenanceRun('retention', new Date(now().getTime() - RETENTION_LEASE_STALE_MS));
  if (!run) return null;
  return { run, execute: () => executeRetention(store, run, options) };
}

/**
 * For every workspace with a finite retention, deletes finished runs created before
 * `now - retentionDays`, in batches until none are left. One workspace failing does not stop the
 * others; the first error is recorded on the maintenance run. Deleting is idempotent, so a re-run
 * after a crash just continues. Monthly usage is never touched (ADR-0014).
 */
async function executeRetention(
  store: AppStore,
  run: MaintenanceRun,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? RETENTION_BATCH_PAUSE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const started = Date.now();
  let deleted = 0;
  let workspaces = 0;
  let error: string | null = null;

  try {
    const policies = await store.listRetentionPolicies();
    workspaces = policies.length;
    for (const policy of policies) {
      const cutoff = new Date(now().getTime() - policy.retentionDays * DAY_MS);
      try {
        for (;;) {
          const n = await store.pruneReviewRuns(policy.workspaceId, cutoff, batchSize);
          deleted += n;
          if (n < batchSize) break;
          await sleep(pauseMs);
        }
      } catch (err) {
        error ??= describeError(err);
        options.logger?.error(
          { event: 'maintenance.retention_failed', workspaceId: policy.workspaceId, errorName: err instanceof Error ? err.name : 'unknown' },
          'Run retention failed for a workspace',
        );
      }
    }
  } catch (err) {
    error ??= describeError(err);
  }

  await store.finishMaintenanceRun(run.id, { deletedCount: deleted, error });
  options.logger?.info(
    { event: 'maintenance.retention', runId: run.id, workspaces, deleted, ms: Date.now() - started, failed: error !== null },
    `Run retention finished: ${deleted} run(s) deleted across ${workspaces} workspace(s)`,
  );
  return { runId: run.id, workspaces, deleted, error };
}

/** Takes the lease and runs the cleanup; `null` when another cleanup is in progress. */
export async function runRetention(store: AppStore, options: RetentionOptions = {}): Promise<RetentionResult | null> {
  const lease = await startRetention(store, options);
  if (!lease) {
    options.logger?.info({ event: 'maintenance.retention_skipped', reason: 'lease_held' }, 'Run retention skipped: already running');
    return null;
  }
  return lease.execute();
}

import type { RunEventPublisher } from './run-events.js';
import type { AppStore, FinishReviewRunOptions, NewReviewRun, ReviewRun, StaleRunRef } from './types.js';

/**
 * Wraps a store so every run row it creates or moves to a new status also publishes a live event
 * (ADR-0021): `createReviewRun` → `created`, `finishReviewRun` and the stale sweep → `updated`.
 * The event goes out only after the store call succeeded. Heartbeats change no status and publish
 * nothing. Every other method is the wrapped store's own, unchanged.
 */
export function withRunEvents(store: AppStore, publisher: RunEventPublisher): AppStore {
  const overrides: Partial<AppStore> = {
    async createReviewRun(run: NewReviewRun): Promise<ReviewRun> {
      const created = await store.createReviewRun(run);
      publisher.publish({ workspaceId: created.workspaceId, runId: created.id, status: created.status, kind: 'created' });
      return created;
    },
    async finishReviewRun(workspaceId: string, id: string, result: FinishReviewRunOptions): Promise<void> {
      await store.finishReviewRun(workspaceId, id, result);
      publisher.publish({ workspaceId, runId: id, status: result.status, kind: 'updated' });
    },
    async failStaleRuns(heartbeatBefore: Date, onFailed?: (failed: readonly StaleRunRef[]) => void): Promise<number> {
      return store.failStaleRuns(heartbeatBefore, (failed) => {
        for (const ref of failed) {
          publisher.publish({ workspaceId: ref.workspaceId, runId: ref.id, status: 'failed', kind: 'updated' });
        }
        onFailed?.(failed);
      });
    },
  };
  return new Proxy(store, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop as keyof AppStore];
      }
      const value: unknown = Reflect.get(target, prop);
      // Methods run against the real store, so private fields and `this` keep working.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

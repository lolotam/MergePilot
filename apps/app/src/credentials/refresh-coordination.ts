import type { Secret } from '@mergepilot/engine';

// Leave pooled database connections available for ordinary requests while refresh holds a lock.
const MAX_REFRESHES = 2;
let active = 0;
const waiters: Array<() => void> = [];
const pending = new WeakMap<object, Map<string, Promise<Secret>>>();

async function acquire(): Promise<void> {
  if (active < MAX_REFRESHES) { active++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

/** Single-flight per store/workspace/provider, plus a process-wide bound on refresh transactions. */
export function coordinateRefresh(store: object, key: string, refresh: () => Promise<Secret>): Promise<Secret> {
  const entries = pending.get(store) ?? new Map<string, Promise<Secret>>();
  pending.set(store, entries);
  const existing = entries.get(key);
  if (existing) return existing;
  const task = (async () => {
    await acquire();
    try { return await refresh(); }
    finally { release(); }
  })().finally(() => {
    entries.delete(key);
    if (entries.size === 0) pending.delete(store);
  });
  entries.set(key, task);
  return task;
}

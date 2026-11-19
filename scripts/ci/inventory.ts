import { log } from 'node:console';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function assertCompleteShards(complete: readonly string[], shards: readonly (readonly string[])[]): void {
  if (complete.length === 0 || shards.length !== 2 || shards.some((shard) => shard.length === 0)) {
    throw new Error('Expected a nonempty complete inventory and two nonempty shards');
  }
  const all = new Set(complete);
  if (all.size !== complete.length) throw new Error('Duplicate entry in complete inventory');
  const seen = new Set<string>();
  for (const entry of shards.flat()) {
    if (!all.has(entry)) throw new Error(`Unexpected shard entry: ${entry}`);
    if (seen.has(entry)) throw new Error(`Duplicate shard entry: ${entry}`);
    seen.add(entry);
  }
  if (seen.size !== all.size) throw new Error('Shards omit complete inventory entries');
}

// Vitest 5's list --filesOnly bypasses pool sharding. Use the same configured sequencer
// that its execution pool applies, without importing tests, running hooks, or opening a DB.
export async function listInventory(root: string, shard?: string): Promise<string[]> {
  const { createVitest } = await import('vitest/node');
  const context = await createVitest({ root, watch: false, run: true, maxWorkers: 2, ...(shard ? { shard } : {}) });
  try {
    let entries = await context.getRelevantTestSpecifications();
    if (shard) {
      const sequencer = new context.config.sequence.sequencer(context);
      entries = await sequencer.shard([...entries]);
    }
    return entries.map((entry) =>
      `${entry.project.name}:${relative(root, entry.moduleId).replaceAll('\\', '/')}`).sort();
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, '../..');
  const complete = await listInventory(root);
  const shards = [];
  for (const shard of ['1/2', '2/2']) shards.push(await listInventory(root, shard));
  assertCompleteShards(complete, shards);
  log(JSON.stringify({ complete: complete.length, shards: shards.map((shard) => shard.length), duplicates: 0 }));
}

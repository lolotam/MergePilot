import type { WorkspaceRestore } from './backup-types.js';
import {
  BotNameTakenError,
  DEFAULT_BOT_NAME,
  InvalidBotSlotError,
  isExtraBotSlot,
  sameBotName,
  type ReviewerBot,
} from './bot-types.js';
import { deleteMemoryWorkspaceBots, listMemoryBots, upsertMemoryBot, type MemoryBots } from './memory-bots.js';
import type { MemoryStore } from './memory-store.js';
import type { KeyProvider, StoredCredential, StoredProviderKey, WorkspaceSettings } from './types.js';

// Workspace-wide writes of the MemoryStore: a settings restore (the twin of pg-backup.ts, ADR-0018)
// and deleting a workspace.

export interface MemoryRestoreTarget {
  readonly bots: MemoryBots;
  readonly settings: Map<string, WorkspaceSettings>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  saveCredential(credential: StoredCredential): Promise<void>;
  modifyProviderKeys(
    workspaceId: string,
    provider: KeyProvider,
    change: (current: StoredProviderKey[]) => Promise<{ keys: StoredProviderKey[]; cursor?: number }>,
  ): Promise<StoredProviderKey[]>;
}

/** Throws BotNameTakenError / InvalidBotSlotError when the restored names or slots would clash. */
function checkBots(mainName: string, bots: readonly ReviewerBot[]): void {
  const seenSlots = new Set<number>();
  for (const [index, bot] of bots.entries()) {
    if (!isExtraBotSlot(bot.slot) || seenSlots.has(bot.slot)) throw new InvalidBotSlotError(bot.slot);
    seenSlots.add(bot.slot);
    const clash = sameBotName(bot.name, mainName) || bots.slice(0, index).some((other) => sameBotName(other.name, bot.name));
    if (clash) throw new BotNameTakenError(bot.name);
  }
}

/** Every check runs before the first write, so a failed restore changes nothing, like the Postgres transaction. */
export async function restoreMemoryWorkspace(
  store: MemoryRestoreTarget,
  workspaceId: string,
  restore: WorkspaceRestore,
): Promise<void> {
  const mainName = restore.settings?.botName ?? store.settings.get(workspaceId)?.botName ?? DEFAULT_BOT_NAME;
  checkBots(mainName, restore.bots ?? listMemoryBots(store.bots, workspaceId));

  if (restore.bots) {
    deleteMemoryWorkspaceBots(store.bots, workspaceId);
    for (const bot of restore.bots) upsertMemoryBot(store.bots, workspaceId, bot, mainName);
  }
  if (restore.settings) await store.saveSettings({ ...restore.settings, workspaceId });
  for (const credential of restore.credentials ?? []) await store.saveCredential({ ...credential, workspaceId });
  const groups = new Map<KeyProvider, StoredProviderKey[]>();
  for (const key of restore.providerKeys ?? []) {
    const list = groups.get(key.provider) ?? [];
    list.push({ ...key, workspaceId });
    groups.set(key.provider, list);
  }
  for (const [provider, keys] of groups) {
    const ordered = [...keys].sort((a, b) => a.position - b.position);
    await store.modifyProviderKeys(workspaceId, provider, async () => ({ keys: ordered, cursor: 0 }));
  }
}

/** Drops the workspace's keys, settings, bots, runs and usage, and unlinks its installations. */
export function deleteMemoryWorkspace(
  store: Pick<MemoryStore, 'deletedWorkspaces' | 'credentials' | 'providerKeys' | 'keyCursors' | 'settings' | 'bots' | 'runs' | 'usage' | 'installations'>,
  workspaceId: string,
): void {
  store.deletedWorkspaces.add(workspaceId);
  for (const [key, cred] of store.credentials.entries()) {
    if (cred.workspaceId === workspaceId) {
      store.credentials.delete(key);
    }
  }
  for (const [key, rows] of store.providerKeys.entries()) {
    if (rows.some((row) => row.workspaceId === workspaceId)) store.providerKeys.delete(key);
  }
  for (const key of store.keyCursors.keys()) {
    if (key.startsWith(`${workspaceId}:`)) store.keyCursors.delete(key);
  }
  store.settings.delete(workspaceId);
  deleteMemoryWorkspaceBots(store.bots, workspaceId);
  for (const [key, run] of store.runs.entries()) {
    if (run.workspaceId === workspaceId) {
      store.runs.delete(key);
    }
  }
  for (const [key, row] of store.usage.entries()) {
    if (row.workspaceId === workspaceId) store.usage.delete(key);
  }
  for (const [id, inst] of store.installations.entries()) {
    if ('workspaceId' in inst && inst.workspaceId === workspaceId) {
      const { workspaceId: _, ...unlinked } = inst;
      store.installations.set(id, unlinked);
    }
  }
}

import type { WorkspaceRestore } from './backup-types.js';
import {
  BotNameTakenError,
  DEFAULT_BOT_NAME,
  InvalidBotSlotError,
  isExtraBotSlot,
  sameBotName,
  type ReviewerBot,
} from './bot-types.js';
import type { KeyProvider, ProviderKeyChange, StoredCredential, StoredProviderKey, WorkspaceSettings } from './types.js';
import { deleteMemoryWorkspaceBots, listMemoryBots, upsertMemoryBot, type MemoryBots } from './memory-bots.js';
import { deleteMemoryWorkspaceAuthPreferences } from './memory-auth-preferences.js';
import {
  assertMemorySkill, deleteMemoryWorkspaceSkills, getMemorySkill, insertMemorySkill, updateMemorySkill, type MemorySkills,
} from './memory-skills.js';
import { MAX_WORKSPACE_SKILLS, SkillLimitError, type ReviewSkillRecord } from './skill-types.js';
import { listMemoryProviderKeys } from './memory-provider-keys.js';
import type { MemoryStore } from './memory-store.js';
import type { MemoryKeyTables } from './memory-provider-keys.js';

// Workspace-wide writes of the MemoryStore: a settings restore (the twin of pg-backup.ts, ADR-0018)
// and deleting a workspace.

export interface MemoryRestoreTarget {
  readonly bots: MemoryBots;
  readonly skills: MemorySkills;
  readonly settings: Map<string, WorkspaceSettings>;
  readonly credentials: Map<string, StoredCredential>;
  readonly providerKeys: Map<string, StoredProviderKey[]>;
  saveSettings(settings: WorkspaceSettings): Promise<void>;
  saveCredential(credential: StoredCredential): Promise<void>;
  modifyProviderKeys(
    workspaceId: string,
    provider: KeyProvider,
    change: (current: StoredProviderKey[], parent: StoredCredential | null) => Promise<ProviderKeyChange>,
  ): Promise<StoredProviderKey[]>;
}

const slotKey = (workspaceId: string, provider: string): string => `${workspaceId}:${provider}`;

interface WorkspaceSnapshot {
  settings: WorkspaceSettings | undefined;
  skills: ReviewSkillRecord[];
  bots: ReviewerBot[];
  credentials: StoredCredential[];
  providerKeys: StoredProviderKey[];
  keyCursors: Array<[string, number]>;
  authPrefs: Array<[string, import('./types.js').ProviderAuthMethod]>;
}

function snapshotWorkspace(store: MemoryRestoreTarget, workspaceId: string): WorkspaceSnapshot {
  const credentials: StoredCredential[] = [];
  for (const cred of store.credentials.values()) {
    if (cred.workspaceId === workspaceId) credentials.push({ ...cred });
  }
  const providerKeys: StoredProviderKey[] = [];
  for (const rows of store.providerKeys.values()) {
    for (const row of rows) {
      if (row.workspaceId === workspaceId) providerKeys.push({ ...row });
    }
  }
  const mem = store as MemoryStore;
  const keyCursors = [...mem.keyCursors.entries()].filter(([key]) => key.startsWith(`${workspaceId}:`));
  const authPrefs = [...mem.authPreferences.entries()].filter(([key]) => key.startsWith(`${workspaceId}:`));
  return {
    settings: store.settings.get(workspaceId) ? { ...store.settings.get(workspaceId)! } : undefined,
    skills: [...store.skills.values()].filter((s) => s.workspaceId === workspaceId).map((s) => ({ ...s })),
    bots: listMemoryBots(store.bots, workspaceId),
    credentials,
    providerKeys,
    keyCursors,
    authPrefs,
  };
}

function revertWorkspace(store: MemoryRestoreTarget, workspaceId: string, snap: WorkspaceSnapshot): void {
  const mem = store as MemoryStore;
  if (snap.settings) store.settings.set(workspaceId, { ...snap.settings });
  else store.settings.delete(workspaceId);
  deleteMemoryWorkspaceSkills(store.skills, workspaceId);
  for (const skill of snap.skills) store.skills.set(skill.id, { ...skill });
  deleteMemoryWorkspaceBots(store.bots, workspaceId);
  for (const bot of snap.bots) upsertMemoryBot(store.bots, workspaceId, bot, snap.settings?.botName);
  for (const key of [...store.credentials.keys()]) {
    const cred = store.credentials.get(key);
    if (cred?.workspaceId === workspaceId) store.credentials.delete(key);
  }
  for (const cred of snap.credentials) store.credentials.set(slotKey(workspaceId, cred.provider), { ...cred });
  for (const key of [...store.providerKeys.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) store.providerKeys.delete(key);
  }
  const groups = new Map<KeyProvider, StoredProviderKey[]>();
  for (const row of snap.providerKeys) {
    const list = groups.get(row.provider) ?? [];
    list.push({ ...row });
    groups.set(row.provider, list);
  }
  for (const [provider, rows] of groups) {
    store.providerKeys.set(slotKey(workspaceId, provider), rows.map((row) => ({ ...row })));
  }
  for (const key of [...mem.keyCursors.keys()]) {
    if (key.startsWith(`${workspaceId}:`)) mem.keyCursors.delete(key);
  }
  for (const [key, cursor] of snap.keyCursors) mem.keyCursors.set(key, cursor);
  deleteMemoryWorkspaceAuthPreferences(mem, workspaceId);
  for (const [key, method] of snap.authPrefs) {
    mem.authPreferences.set(key, method);
  }
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

  const tables: MemoryKeyTables = {
    credentials: store.credentials,
    providerKeys: store.providerKeys,
    keyCursors: (store as MemoryStore).keyCursors,
    authPreferences: (store as MemoryStore).authPreferences,
  };
  // Tests and local dev only: these changes are planned without the per-provider lock. The
  // Postgres store plans and applies each one under that lock inside the restore transaction.
  const dualWrites: Array<{ provider: KeyProvider; next: ProviderKeyChange }> = [];
  for (const entry of restore.dualProviderKeyChanges ?? []) {
    const key = slotKey(workspaceId, entry.provider);
    const parentRow = tables.credentials.get(key);
    const parent = parentRow ? { ...parentRow } : null;
    const current = listMemoryProviderKeys(tables, workspaceId, entry.provider);
    dualWrites.push({ provider: entry.provider, next: await entry.change(current, parent) });
  }

  const snapshot = snapshotWorkspace(store, workspaceId);
  try {
  for (const skill of restore.skills ?? []) {
    if (getMemorySkill(store.skills, workspaceId, skill.id)) {
      updateMemorySkill(store.skills, workspaceId, skill.id, {
        name: skill.name,
        content: { text: skill.content, hash: skill.contentHash, sizeTokens: skill.sizeTokens },
        userId: skill.userId,
      });
    } else {
      insertMemorySkill(store.skills, workspaceId, skill);
    }
  }
  if ([...store.skills.values()].filter((s) => s.workspaceId === workspaceId).length > MAX_WORKSPACE_SKILLS) throw new SkillLimitError();
  for (const bot of restore.bots ?? []) assertMemorySkill(store.skills, workspaceId, bot.skillId);
  if (restore.bots) {
    deleteMemoryWorkspaceBots(store.bots, workspaceId);
    for (const bot of restore.bots) upsertMemoryBot(store.bots, workspaceId, bot, mainName);
  }
  if (restore.settings) await store.saveSettings({ ...restore.settings, workspaceId });
  const dualProviders = new Set((restore.dualProviderKeyChanges ?? []).map((entry) => entry.provider));
  for (const credential of restore.credentials ?? []) {
    if (dualProviders.has(credential.provider)) continue;
    await store.saveCredential({ ...credential, workspaceId });
  }
  const groups = new Map<KeyProvider, StoredProviderKey[]>();
  for (const key of restore.providerKeys ?? []) {
    if (dualProviders.has(key.provider)) continue;
    const list = groups.get(key.provider) ?? [];
    list.push({ ...key, workspaceId });
    groups.set(key.provider, list);
  }
  for (const [provider, keys] of groups) {
    const ordered = [...keys].sort((a, b) => a.position - b.position);
    const parentCred = restore.credentials?.find((c) => c.provider === provider) ?? null;
    await store.modifyProviderKeys(workspaceId, provider, async () => ({
      keys: ordered,
      cursor: 0,
      parent: parentCred,
    }));
  }
  for (const { provider, next } of dualWrites) {
    await store.modifyProviderKeys(workspaceId, provider, async () => next);
  }
  } catch (error) {
    revertWorkspace(store, workspaceId, snapshot);
    throw error;
  }
}

/** Drops the workspace's keys, settings, bots, runs and usage, and unlinks its installations. */
export function deleteMemoryWorkspace(
  store: Pick<MemoryStore, 'deletedWorkspaces' | 'credentials' | 'providerKeys' | 'keyCursors' | 'authPreferences' | 'settings' | 'bots' | 'runs' | 'usage' | 'installations'> & { skills: MemorySkills },
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
  deleteMemoryWorkspaceAuthPreferences(store, workspaceId);
  store.settings.delete(workspaceId);
  deleteMemoryWorkspaceBots(store.bots, workspaceId);
  deleteMemoryWorkspaceSkills(store.skills, workspaceId);
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

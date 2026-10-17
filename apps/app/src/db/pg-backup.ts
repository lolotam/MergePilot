import { and, eq } from 'drizzle-orm';
import {
  BotNameTakenError,
  DEFAULT_BOT_NAME,
  InvalidBotSlotError,
  isExtraBotSlot,
  sameBotName,
  type KeyProvider,
  type StoredCredential,
  type StoredProviderKey,
  type WorkspaceRestore,
  MAX_WORKSPACE_SKILLS,
  SkillLimitError,
  SkillNameTakenError,
  UnknownSkillError,
} from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { writePgSettings } from './pg-settings.js';
import { listPgProviderKeys, replacePgProviderKeys, writePgKeyCursor } from './pg-provider-keys.js';
import { readParentCredential, writeProviderKeyChangeTx } from './pg-key-roster.js';
import {
  countSkills, insertSkill, isConstraintViolation, isSkillNameConflict, lockSkills, SKILL_FOREIGN_KEYS, updateSkill,
} from './pg-skills.js';
import { providerCredentials, reviewerBots, reviewSkills, workspaceSettings } from './schema.js';
import { lockBotNames, lockCredential, withLiveWorkspace, type AppTx } from './workspace-lock.js';

// Settings restore (ADR-0018): settings, extra bots and keys in one transaction.

/** Upserts one vault-encrypted credential by (workspace, provider) inside the caller's transaction. */
export async function writePgCredential(tx: AppTx, credential: StoredCredential): Promise<void> {
  await lockCredential(tx, credential.workspaceId, credential.provider);
  const values = {
    id: credential.id,
    ciphertext: credential.ciphertext,
    keyVersion: credential.keyVersion,
    last4: credential.last4,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    baseUrl: credential.baseUrl ?? null,
  };
  await tx
    .insert(providerCredentials)
    .values({ workspaceId: credential.workspaceId, provider: credential.provider, ...values })
    .onConflictDoUpdate({
      target: [providerCredentials.workspaceId, providerCredentials.provider],
      set: values,
    });
}

/** Replaces the extra bots: every name must differ from the main bot's and from each other's. */
async function replacePgBots(tx: AppTx, workspaceId: string, bots: NonNullable<WorkspaceRestore['bots']>): Promise<void> {
  const main = await tx
    .select({ name: workspaceSettings.botName })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  const mainName = main[0]?.name ?? DEFAULT_BOT_NAME;
  const slots = new Set<number>();
  for (const [index, bot] of bots.entries()) {
    if (!isExtraBotSlot(bot.slot) || slots.has(bot.slot)) throw new InvalidBotSlotError(bot.slot);
    slots.add(bot.slot);
    if (sameBotName(bot.name, mainName) || bots.slice(0, index).some((other) => sameBotName(other.name, bot.name))) {
      throw new BotNameTakenError(bot.name);
    }
  }
  if (bots.length === 0) return;
  await tx.insert(reviewerBots).values(
    bots.map((bot) => ({
      workspaceId,
      slot: bot.slot,
      name: bot.name,
      logo: bot.logo,
      active: bot.active,
      provider: bot.provider,
      model: bot.model,
      effort: bot.effort,
      fallback: bot.fallback,
      skillId: bot.skillId ?? null,
    })),
  );
}

/**
 * Upserts the restored skills by id (the plan reuses the id of a same-named skill, ADR-0034) under
 * the skill lock, and re-checks the workspace limit: a skill created since the plan may push it over.
 */
async function writePgSkills(tx: AppTx, workspaceId: string, skills: NonNullable<WorkspaceRestore['skills']>): Promise<void> {
  await lockSkills(tx, workspaceId);
  for (const skill of skills) {
    // Locked, so a delete or rename of this skill waits for the restore instead of landing in
    // between. The plan matched the id by name: a skill renamed since then is another skill now.
    const [existing] = await tx
      .select({ id: reviewSkills.id, name: reviewSkills.name })
      .from(reviewSkills)
      .where(and(eq(reviewSkills.workspaceId, workspaceId), eq(reviewSkills.id, skill.id)))
      .for('update');
    if (existing && !sameSkillName(existing.name, skill.name)) throw new SkillNameTakenError(skill.name);
    if (existing) {
      await updateSkill(tx, workspaceId, skill.id, {
        name: skill.name,
        content: { text: skill.content, hash: skill.contentHash, sizeTokens: skill.sizeTokens },
        userId: skill.userId,
      });
    } else {
      await insertSkill(tx, workspaceId, skill);
    }
  }
  if ((await countSkills(tx, workspaceId)) > MAX_WORKSPACE_SKILLS) throw new SkillLimitError();
}

const sameSkillName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A restore racing a skill write: the plan's names or ids no longer match the workspace. */
function skillRaceError(error: unknown, restore: WorkspaceRestore): Error | undefined {
  if (isSkillNameConflict(error)) return new SkillNameTakenError(restore.skills?.[0]?.name ?? '');
  if (isConstraintViolation(error, '23503', SKILL_FOREIGN_KEYS)) return new UnknownSkillError('restored');
  return undefined;
}

export async function restorePgWorkspace(db: AppDb, workspaceId: string, restore: WorkspaceRestore): Promise<void> {
  try {
    await writeRestore(db, workspaceId, restore);
  } catch (error) {
    throw skillRaceError(error, restore) ?? error;
  }
}

async function writeRestore(db: AppDb, workspaceId: string, restore: WorkspaceRestore): Promise<void> {
  await withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockBotNames(tx, workspaceId);
    // Skills first: the restored settings and bots may name them (ADR-0034).
    if (restore.skills) await writePgSkills(tx, workspaceId, restore.skills);
    // Old extra bots go first, so the settings' bot name is checked against the restored ones only.
    if (restore.bots) await tx.delete(reviewerBots).where(eq(reviewerBots.workspaceId, workspaceId));
    if (restore.settings) await writePgSettings(tx, { ...restore.settings, workspaceId });
    if (restore.bots) await replacePgBots(tx, workspaceId, restore.bots);
    const dualProviders = new Set((restore.dualProviderKeyChanges ?? []).map((entry) => entry.provider));
    for (const credential of [...(restore.credentials ?? [])].sort((a, b) => a.provider.localeCompare(b.provider))) {
      if (dualProviders.has(credential.provider)) continue;
      await writePgCredential(tx, { ...credential, workspaceId });
    }
    const groups = new Map<KeyProvider, StoredProviderKey[]>();
    for (const key of restore.providerKeys ?? []) {
      if (dualProviders.has(key.provider)) continue;
      const list = groups.get(key.provider) ?? [];
      list.push({ ...key, workspaceId });
      groups.set(key.provider, list);
    }
    for (const [provider, keys] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ordered = [...keys].sort((a, b) => a.position - b.position);
      await lockCredential(tx, workspaceId, provider);
      await replacePgProviderKeys(tx, workspaceId, provider, ordered);
      await writePgKeyCursor(tx, workspaceId, provider, ordered.length === 0 ? null : 0);
    }
    for (const entry of [...(restore.dualProviderKeyChanges ?? [])].sort((a, b) => a.provider.localeCompare(b.provider))) {
      await lockCredential(tx, workspaceId, entry.provider);
      const parent = await readParentCredential(tx, workspaceId, entry.provider);
      const current = await listPgProviderKeys(tx, workspaceId, entry.provider);
      const next = await entry.change(current, parent);
      await writeProviderKeyChangeTx(tx, workspaceId, entry.provider, next);
    }
  });
}

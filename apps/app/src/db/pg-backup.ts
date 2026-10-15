import { eq } from 'drizzle-orm';
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
} from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { writePgSettings } from './pg-settings.js';
import { replacePgProviderKeys, writePgKeyCursor } from './pg-provider-keys.js';
import { providerCredentials, reviewerBots, workspaceSettings } from './schema.js';
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
    })),
  );
}

export async function restorePgWorkspace(db: AppDb, workspaceId: string, restore: WorkspaceRestore): Promise<void> {
  await withLiveWorkspace(db, workspaceId, async (tx) => {
    await lockBotNames(tx, workspaceId);
    // Old extra bots go first, so the settings' bot name is checked against the restored ones only.
    if (restore.bots) await tx.delete(reviewerBots).where(eq(reviewerBots.workspaceId, workspaceId));
    if (restore.settings) await writePgSettings(tx, { ...restore.settings, workspaceId });
    if (restore.bots) await replacePgBots(tx, workspaceId, restore.bots);
    for (const credential of [...(restore.credentials ?? [])].sort((a, b) => a.provider.localeCompare(b.provider))) {
      await writePgCredential(tx, { ...credential, workspaceId });
    }
    const groups = new Map<KeyProvider, StoredProviderKey[]>();
    for (const key of restore.providerKeys ?? []) {
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
  });
}

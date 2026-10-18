import { and, asc, eq, ne } from 'drizzle-orm';
import {
  BotNameTakenError,
  DEFAULT_BOT_NAME,
  InvalidBotSlotError,
  isExtraBotSlot,
  sameBotName,
  type ApiProvider,
  type BotLogo,
  type FallbackSetting,
  type ReviewerBot,
  UnknownSkillError,
} from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { skillFields } from './pg-settings.js';
import { isConstraintViolation, SKILL_FOREIGN_KEYS, SKILL_ID_PATTERN } from './pg-skills.js';
import { reviewerBots, workspaceSettings } from './schema.js';
import { lockBotNames, withLiveWorkspace } from './workspace-lock.js';

// The reviewer panel's extra bots, slots 2-5 (ADR-0017). The main bot (slot 1) is the settings row.

const BOT_NAME_INDEX = 'idx_reviewer_bots_workspace_name';

function mapBotRow(row: typeof reviewerBots.$inferSelect): ReviewerBot {
  return {
    slot: Number(row.slot),
    name: row.name,
    logo: row.logo as BotLogo,
    active: row.active,
    provider: row.provider as ApiProvider,
    model: row.model,
    effort: row.effort ?? null,
    fallback: Array.isArray(row.fallback) ? (row.fallback as FallbackSetting[]) : [],
    ...skillFields(row),
  };
}

/** True when `error` (or a driver error it wraps) is a unique violation of the bot name index. */
function isBotNameConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const fields = current as Error & { code?: unknown; constraint?: unknown };
    if (fields.code === '23505' && (fields.constraint === BOT_NAME_INDEX || fields.message.includes(BOT_NAME_INDEX))) {
      return true;
    }
    current = fields.cause;
  }
  return false;
}

export async function listPgReviewerBots(db: AppDb, workspaceId: string): Promise<ReviewerBot[]> {
  const rows = await db
    .select()
    .from(reviewerBots)
    .where(eq(reviewerBots.workspaceId, workspaceId))
    .orderBy(asc(reviewerBots.slot));
  return rows.map(mapBotRow);
}

/**
 * Creates or replaces the bot in its slot under the live-workspace lock. The name must differ
 * (trimmed, ignoring case) from the other extra bots and from the main bot's stored name; the
 * unique index on `lower(name)` closes the race between two concurrent saves.
 */
export async function upsertPgReviewerBot(db: AppDb, workspaceId: string, bot: ReviewerBot): Promise<ReviewerBot> {
  if (!isExtraBotSlot(bot.slot)) throw new InvalidBotSlotError(bot.slot);
  if (bot.skillId != null && !SKILL_ID_PATTERN.test(bot.skillId)) throw new UnknownSkillError(bot.skillId);
  const values = {
    name: bot.name,
    logo: bot.logo,
    active: bot.active,
    provider: bot.provider,
    model: bot.model,
    effort: bot.effort,
    fallback: bot.fallback,
    // Left out (undefined), the update keeps the stored skill and note; a new row starts on Default.
    ...(bot.skillId !== undefined ? { skillId: bot.skillId, skillRemovedName: bot.skillRemovedName ?? null } : {}),
    updatedAt: new Date(),
  };
  try {
    return await withLiveWorkspace(db, workspaceId, async (tx) => {
      await lockBotNames(tx, workspaceId);
      const main = await tx
        .select({ name: workspaceSettings.botName })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));
      const others = await tx
        .select({ name: reviewerBots.name })
        .from(reviewerBots)
        .where(and(eq(reviewerBots.workspaceId, workspaceId), ne(reviewerBots.slot, bot.slot)));
      const names = [main[0]?.name ?? DEFAULT_BOT_NAME, ...others.map((o) => o.name)];
      if (names.some((name) => sameBotName(name, bot.name))) throw new BotNameTakenError(bot.name);
      const saved = await tx
        .insert(reviewerBots)
        .values({ workspaceId, slot: bot.slot, ...values })
        .onConflictDoUpdate({ target: [reviewerBots.workspaceId, reviewerBots.slot], set: values })
        .returning();
      const row = saved[0];
      if (!row) throw new Error('reviewer bot upsert returned no row');
      return mapBotRow(row);
    });
  } catch (error) {
    if (isBotNameConflict(error)) throw new BotNameTakenError(bot.name);
    if (bot.skillId && isConstraintViolation(error, '23503', SKILL_FOREIGN_KEYS)) throw new UnknownSkillError(bot.skillId);
    throw error;
  }
}

export async function deletePgReviewerBot(db: AppDb, workspaceId: string, slot: number): Promise<boolean> {
  const deleted = await db
    .delete(reviewerBots)
    .where(and(eq(reviewerBots.workspaceId, workspaceId), eq(reviewerBots.slot, slot)))
    .returning();
  return deleted.length > 0;
}


import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  MAX_WORKSPACE_SKILLS,
  SkillLimitError,
  SkillNameTakenError,
  type DeletedReviewSkill,
  type NewReviewSkill,
  type ReviewSkillChange,
  type ReviewSkillRecord,
  type ReviewSkillSummary,
} from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { reviewerBots, reviewSkills, workspaceSettings } from './schema.js';
import { lockBotNames, withLiveWorkspace, type AppTx, type PgBase } from './workspace-lock.js';

// Review skills (ADR-0034). Bots reference a skill through composite foreign keys
// (workspace_id, skill_id), so a bot can only use a skill of its own workspace.

const SKILL_NAME_INDEX = 'idx_review_skills_workspace_name';
/** The composite foreign keys of migration 0014. */
export const SKILL_FOREIGN_KEYS = ['workspace_settings_skill_fk', 'reviewer_bots_skill_fk'] as const;
/** Namespace (first key) of the advisory lock that serialises skill creation per workspace. */
const SKILL_LOCK_NAMESPACE = 17003;

/** A skill id is a uuid; anything else names no skill (and would be a Postgres type error). */
export const SKILL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `error` (or a driver error it wraps) is a `code` violation of one of `constraints`. */
export function isConstraintViolation(error: unknown, code: string, constraints: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const fields = current as Error & { code?: unknown; constraint?: unknown };
    if (fields.code === code && constraints.some((name) => fields.constraint === name || fields.message.includes(name))) {
      return true;
    }
    current = fields.cause;
  }
  return false;
}

const summaryColumns = {
  id: reviewSkills.id,
  workspaceId: reviewSkills.workspaceId,
  name: reviewSkills.name,
  contentHash: reviewSkills.contentHash,
  sizeTokens: reviewSkills.sizeTokens,
  createdBy: reviewSkills.createdBy,
  updatedBy: reviewSkills.updatedBy,
  createdAt: reviewSkills.createdAt,
  updatedAt: reviewSkills.updatedAt,
};

export async function listPgReviewSkills(db: AppDb, workspaceId: string): Promise<ReviewSkillSummary[]> {
  return db
    .select(summaryColumns)
    .from(reviewSkills)
    .where(eq(reviewSkills.workspaceId, workspaceId))
    .orderBy(asc(sql`lower(${reviewSkills.name})`));
}

export async function getPgReviewSkill(db: AppDb, workspaceId: string, skillId: string): Promise<ReviewSkillRecord | null> {
  if (!SKILL_ID_PATTERN.test(skillId)) return null;
  const rows = await db
    .select()
    .from(reviewSkills)
    .where(and(eq(reviewSkills.workspaceId, workspaceId), eq(reviewSkills.id, skillId)));
  return rows[0] ?? null;
}

/** Serialises the writes that add skills to a workspace until the transaction ends. */
export async function lockSkills(tx: AppTx, workspaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SKILL_LOCK_NAMESPACE}, hashtext(${workspaceId}))`);
}

/** How many skills the workspace has, inside the caller's transaction. */
export async function countSkills(tx: AppTx, workspaceId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(reviewSkills).where(eq(reviewSkills.workspaceId, workspaceId));
  return row?.n ?? 0;
}

/** True when `error` is the unique violation of a skill name (ignoring case) in the workspace. */
export function isSkillNameConflict(error: unknown): boolean {
  return isConstraintViolation(error, '23505', [SKILL_NAME_INDEX]);
}

/** Creates a skill under the live-workspace lock; the count check and the insert are serialised. */
export async function createPgReviewSkill(db: AppDb, workspaceId: string, skill: NewReviewSkill): Promise<ReviewSkillRecord> {
  try {
    return await withLiveWorkspace(db, workspaceId, async (tx) => {
      await lockSkills(tx, workspaceId);
      if ((await countSkills(tx, workspaceId)) >= MAX_WORKSPACE_SKILLS) throw new SkillLimitError();
      return insertSkill(tx, workspaceId, skill);
    });
  } catch (error) {
    if (isSkillNameConflict(error)) throw new SkillNameTakenError(skill.name);
    throw error;
  }
}

/** Inserts a skill row inside the caller's transaction (also used by a restore). */
export async function insertSkill(tx: AppTx, workspaceId: string, skill: NewReviewSkill): Promise<ReviewSkillRecord> {
  const now = new Date();
  const [row] = await tx
    .insert(reviewSkills)
    .values({
      id: skill.id,
      workspaceId,
      name: skill.name,
      content: skill.content,
      contentHash: skill.contentHash,
      sizeTokens: skill.sizeTokens,
      createdBy: skill.userId,
      updatedBy: skill.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('review skill insert returned no row');
  return row;
}

export async function updatePgReviewSkill(
  db: AppDb,
  workspaceId: string,
  skillId: string,
  change: ReviewSkillChange,
): Promise<ReviewSkillRecord | null> {
  if (!SKILL_ID_PATTERN.test(skillId)) return null;
  try {
    return await withLiveWorkspace(db, workspaceId, (tx) => updateSkill(tx, workspaceId, skillId, change));
  } catch (error) {
    if (isSkillNameConflict(error)) throw new SkillNameTakenError(change.name ?? '');
    throw error;
  }
}

/** Updates a skill row inside the caller's transaction (also used by a restore). */
export async function updateSkill(
  tx: AppTx,
  workspaceId: string,
  skillId: string,
  change: ReviewSkillChange,
): Promise<ReviewSkillRecord | null> {
  const [row] = await tx
    .update(reviewSkills)
    .set({
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.content
        ? { content: change.content.text, contentHash: change.content.hash, sizeTokens: change.content.sizeTokens }
        : {}),
      updatedBy: change.userId,
      updatedAt: new Date(),
    })
    .where(and(eq(reviewSkills.workspaceId, workspaceId), eq(reviewSkills.id, skillId)))
    .returning();
  return row ?? null;
}

/**
 * Deletes a skill. In the same transaction every bot using it falls back to Default and keeps
 * the skill's name as `skill_removed_name` (ADR-0034, owner's choice س49 أ).
 */
export async function deletePgReviewSkill(db: AppDb, workspaceId: string, skillId: string): Promise<DeletedReviewSkill | null> {
  if (!SKILL_ID_PATTERN.test(skillId)) return null;
  return db.transaction(async (lockedTx) => {
    // The bot-name lock first, like a restore and a bot save: they touch the same settings and bot
    // rows, so all of them take the rows in the same order and cannot deadlock.
    await lockBotNames(lockedTx, workspaceId);
    // Widened: `returning({...})` does not resolve on the node-postgres | PGlite union.
    const tx: PgBase = lockedTx;
    const [skill] = await tx
      .select({ name: reviewSkills.name })
      .from(reviewSkills)
      .where(and(eq(reviewSkills.workspaceId, workspaceId), eq(reviewSkills.id, skillId)))
      .for('update');
    if (!skill) return null;
    const fallBack = { skillId: null, skillRemovedName: skill.name };
    const main = await tx
      .update(workspaceSettings)
      .set(fallBack)
      .where(and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.skillId, skillId)))
      .returning({ workspaceId: workspaceSettings.workspaceId });
    const extras = await tx
      .update(reviewerBots)
      .set(fallBack)
      .where(and(eq(reviewerBots.workspaceId, workspaceId), eq(reviewerBots.skillId, skillId)))
      .returning({ slot: reviewerBots.slot });
    await tx.delete(reviewSkills).where(and(eq(reviewSkills.workspaceId, workspaceId), eq(reviewSkills.id, skillId)));
    const fellBackSlots = [...(main.length > 0 ? [1] : []), ...extras.map((bot) => Number(bot.slot)).sort((a, b) => a - b)];
    return { name: skill.name, fellBackSlots };
  });
}

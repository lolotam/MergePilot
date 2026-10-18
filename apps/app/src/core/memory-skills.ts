import type { ReviewerBot } from './bot-types.js';
import {
  MAX_WORKSPACE_SKILLS,
  SkillLimitError,
  SkillNameTakenError,
  UnknownSkillError,
  type DeletedReviewSkill,
  type NewReviewSkill,
  type ReviewSkillChange,
  type ReviewSkillRecord,
  type ReviewSkillSummary,
} from './skill-types.js';
import type { WorkspaceSettings } from './types.js';

// In-memory twins of pg-skills.ts (review skills, ADR-0034).

/** Skills keyed by id; every lookup also checks the workspace, like the composite foreign keys. */
export type MemorySkills = Map<string, ReviewSkillRecord>;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const copy = (skill: ReviewSkillRecord): ReviewSkillRecord => ({ ...skill });

function workspaceSkills(skills: MemorySkills, workspaceId: string): ReviewSkillRecord[] {
  return [...skills.values()].filter((s) => s.workspaceId === workspaceId);
}

export function listMemorySkills(skills: MemorySkills, workspaceId: string): ReviewSkillSummary[] {
  return workspaceSkills(skills, workspaceId)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map(({ content: _content, ...summary }) => ({ ...summary }));
}

export function getMemorySkill(skills: MemorySkills, workspaceId: string, skillId: string): ReviewSkillRecord | null {
  const skill = skills.get(skillId);
  return skill && skill.workspaceId === workspaceId ? copy(skill) : null;
}

function assertNameFree(skills: MemorySkills, workspaceId: string, name: string, exceptId?: string): void {
  if (workspaceSkills(skills, workspaceId).some((s) => s.id !== exceptId && sameName(s.name, name))) {
    throw new SkillNameTakenError(name);
  }
}

export function createMemorySkill(skills: MemorySkills, workspaceId: string, skill: NewReviewSkill): ReviewSkillRecord {
  if (workspaceSkills(skills, workspaceId).length >= MAX_WORKSPACE_SKILLS) throw new SkillLimitError();
  return insertMemorySkill(skills, workspaceId, skill);
}

/** Inserts without the per-workspace count check (a restore checks the total itself). */
export function insertMemorySkill(skills: MemorySkills, workspaceId: string, skill: NewReviewSkill): ReviewSkillRecord {
  // The id is the primary key across workspaces, as in Postgres: never overwrite another skill.
  if (skills.has(skill.id)) throw new Error(`review skill ${skill.id} already exists`);
  assertNameFree(skills, workspaceId, skill.name);
  const now = new Date();
  const record: ReviewSkillRecord = {
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
  };
  skills.set(record.id, record);
  return copy(record);
}

export function updateMemorySkill(
  skills: MemorySkills,
  workspaceId: string,
  skillId: string,
  change: ReviewSkillChange,
): ReviewSkillRecord | null {
  const stored = getMemorySkill(skills, workspaceId, skillId);
  if (!stored) return null;
  if (change.name !== undefined) assertNameFree(skills, workspaceId, change.name, skillId);
  const next: ReviewSkillRecord = {
    ...stored,
    ...(change.name !== undefined ? { name: change.name } : {}),
    ...(change.content
      ? { content: change.content.text, contentHash: change.content.hash, sizeTokens: change.content.sizeTokens }
      : {}),
    updatedBy: change.userId,
    updatedAt: new Date(),
  };
  skills.set(skillId, next);
  return copy(next);
}

/** Deletes the skill; the main bot and the extra bots using it fall back to Default. */
export function deleteMemorySkill(
  skills: MemorySkills,
  workspaceId: string,
  skillId: string,
  bots: { settings: Map<string, WorkspaceSettings>; extras: ReviewerBot[]; saveExtra: (bot: ReviewerBot) => void },
): DeletedReviewSkill | null {
  const skill = getMemorySkill(skills, workspaceId, skillId);
  if (!skill) return null;
  const fellBackSlots: number[] = [];
  const settings = bots.settings.get(workspaceId);
  if (settings?.skillId === skillId) {
    bots.settings.set(workspaceId, { ...settings, skillId: null, skillRemovedName: skill.name });
    fellBackSlots.push(1);
  }
  for (const bot of bots.extras) {
    if (bot.skillId !== skillId) continue;
    bots.saveExtra({ ...bot, skillId: null, skillRemovedName: skill.name });
    fellBackSlots.push(bot.slot);
  }
  skills.delete(skillId);
  return { name: skill.name, fellBackSlots };
}

/** The composite foreign key's check: `skillId` must be a skill of this workspace. */
export function assertMemorySkill(skills: MemorySkills, workspaceId: string, skillId: string | null | undefined): void {
  if (skillId != null && !getMemorySkill(skills, workspaceId, skillId)) throw new UnknownSkillError(skillId);
}

/** A bot or settings object as the stores read it back: unset skill fields left out. */
export function withSetSkillFields<T extends { skillId?: string | null | undefined; skillRemovedName?: string | null | undefined }>(value: T): T {
  const { skillId, skillRemovedName, ...rest } = value;
  return { ...rest, ...(skillId ? { skillId } : {}), ...(skillRemovedName ? { skillRemovedName } : {}) } as T;
}

export function deleteMemoryWorkspaceSkills(skills: MemorySkills, workspaceId: string): void {
  for (const skill of workspaceSkills(skills, workspaceId)) skills.delete(skill.id);
}

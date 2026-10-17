import { randomUUID } from 'node:crypto';
import { checkSkillContent, estimateTokens, skillContentHash, skillNameHasCredential } from '@mergepilot/engine';
import { MAX_WORKSPACE_SKILLS, type AppStore, type NewReviewSkill, type ReviewSkillSummary } from '../core/types.js';
import { SkillNameSchema } from './contract-skills.js';
import type { BackupFile } from './contract-backup.js';
import { RestoreProblem } from './backup-restore-problem.js';
import { NAME_CREDENTIAL, skillContentMessage } from './skill-routes.js';

// Review skills in the settings backup (ADR-0034, ADR-0018). Skill ids differ between workspaces,
// so the file names a bot's skill by name (`skillName`) and a restore maps names back to ids.

const key = (name: string) => name.trim().toLowerCase();

/** A skill changed while the export read it: the backup would name a skill it lacks. */
export class BackupChangedError extends Error {
  constructor() {
    super('The workspace skills changed during the export; try again');
    this.name = 'BackupChangedError';
  }
}

/**
 * A settings or bot DTO for the file: its skill by name (null = Default), never by id. A skill id
 * missing from `skills` (assigned or deleted since the listing) throws BackupChangedError rather
 * than exporting the bot on Default.
 */
export function withSkillName<T extends { skillId?: string | null | undefined; skillRemovedName?: string | null | undefined }>(
  dto: T,
  skills: readonly ReviewSkillSummary[],
): Omit<T, 'skillId' | 'skillRemovedName'> & { skillName: string | null } {
  const { skillId, skillRemovedName: _removed, ...rest } = dto;
  if (!skillId) return { ...rest, skillName: null };
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) throw new BackupChangedError();
  return { ...rest, skillName: skill.name };
}

/**
 * The skill a file entry names, and the entry without its skill fields (they are not part of the
 * PUT schemas). `present: false` (an older file) keeps the stored skill of the settings. A
 * `skillName` that is not null or a valid skill name, or that looks like a credential, refuses the
 * restore without echoing the value. `field` names the entry (e.g. `bots[0]`).
 */
export function takeSkillRef(
  entry: Record<string, unknown>,
  field: string,
): { rest: Record<string, unknown>; present: boolean; name: string | null } {
  const { skillName, skillId: _id, skillRemovedName: _removed, ...rest } = entry;
  const present = Object.hasOwn(entry, 'skillName');
  if (!present || skillName === null) return { rest, present, name: null };
  const name = SkillNameSchema.safeParse(skillName);
  if (!name.success) {
    throw new RestoreProblem(400, 'validation_error', `${field}.skillName: must be a skill name or null`, `${field}.skillName`);
  }
  if (skillNameHasCredential(name.data)) {
    throw new RestoreProblem(400, 'skill_has_credential', `${field}.skillName: ${NAME_CREDENTIAL}`, `${field}.skillName`);
  }
  return { rest, present, name: name.data };
}

export interface SkillRestorePlan {
  /** The skills to write, each with its existing id (same name) or a new one. */
  skills: NewReviewSkill[];
  /** Skill ids by lower-cased name, after the restore. */
  idByName: Map<string, string>;
}

/**
 * The file's skills through POST /skills' checks. Upserted by name: a skill of the workspace with
 * the same name (ignoring case) is replaced, the others stay. Without the skills section, only the
 * workspace's own skills can be named.
 */
export async function planSkills(
  store: AppStore,
  workspaceId: string,
  raw: BackupFile['skills'],
  userId: string,
  restoreSkills: boolean,
): Promise<SkillRestorePlan> {
  const existing = await store.listReviewSkills(workspaceId);
  const idByName = new Map(existing.map((s) => [key(s.name), s.id]));
  if (!restoreSkills || !raw) return { skills: [], idByName };

  const skills: NewReviewSkill[] = [];
  for (const [index, entry] of raw.entries()) {
    const field = `skills[${index}]`;
    const name = SkillNameSchema.safeParse(entry.name);
    if (!name.success) throw new RestoreProblem(400, 'validation_error', `${field}.name: ${name.error.issues[0]?.message ?? 'Invalid name'}`, `${field}.name`);
    if (skillNameHasCredential(name.data)) throw new RestoreProblem(400, 'skill_has_credential', `${field}.name: ${NAME_CREDENTIAL}`, `${field}.name`);
    if (skills.some((s) => key(s.name) === key(name.data))) {
      throw new RestoreProblem(409, 'skill_name_taken', `${field}.name: another skill in the file has this name`, `${field}.name`);
    }
    const problem = checkSkillContent(entry.content);
    if (problem) throw new RestoreProblem(400, problem.code, `${field}.content: ${skillContentMessage(problem)}`, `${field}.content`);
    skills.push({
      id: idByName.get(key(name.data)) ?? randomUUID(),
      name: name.data,
      content: entry.content,
      contentHash: skillContentHash(entry.content),
      sizeTokens: estimateTokens(entry.content),
      userId,
    });
  }
  for (const skill of skills) idByName.set(key(skill.name), skill.id);
  if (idByName.size > MAX_WORKSPACE_SKILLS) {
    throw new RestoreProblem(409, 'skill_limit', `A workspace can have at most ${MAX_WORKSPACE_SKILLS} skills`, 'skills');
  }
  return { skills, idByName };
}

/** A named skill's id after the restore; a name that is not there falls back to Default (null). */
export function resolveSkillName(plan: SkillRestorePlan, name: string | null, missing: Set<string>): string | null {
  if (name === null) return null;
  const id = plan.idByName.get(key(name));
  if (!id) missing.add(name);
  return id ?? null;
}

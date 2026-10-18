// Review skills (ADR-0034): Markdown instructions a workspace admin uploads; each bot may use one.
// Re-exported by types.ts.

/** At most this many skills per workspace. */
export const MAX_WORKSPACE_SKILLS = 50;

/** A stored skill. `contentHash` is the sha256 hex of `content`; `sizeTokens` its estimated tokens. */
export interface ReviewSkillRecord {
  id: string;
  workspaceId: string;
  name: string;
  content: string;
  contentHash: string;
  sizeTokens: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A skill as the list shows it: everything but the content. */
export type ReviewSkillSummary = Omit<ReviewSkillRecord, 'content'>;

/** A new skill, already validated (`checkSkillContent`) and hashed by the caller. */
export interface NewReviewSkill {
  id: string;
  name: string;
  content: string;
  contentHash: string;
  sizeTokens: number;
  userId: string;
}

/** A change to a skill: fields left undefined keep the stored value. */
export interface ReviewSkillChange {
  name?: string | undefined;
  content?: { text: string; hash: string; sizeTokens: number } | undefined;
  userId: string;
}

/** What deleting a skill did: the bot slots that used it now review with the core prompt only. */
export interface DeletedReviewSkill {
  name: string;
  fellBackSlots: number[];
}

/** Thrown when another skill of the workspace has this name (ignoring case). */
export class SkillNameTakenError extends Error {
  constructor(name: string) {
    super(`another skill in this workspace is already named "${name}"`);
    this.name = 'SkillNameTakenError';
  }
}

/** Thrown when the workspace already has MAX_WORKSPACE_SKILLS skills. */
export class SkillLimitError extends Error {
  constructor() {
    super(`a workspace can have at most ${MAX_WORKSPACE_SKILLS} skills`);
    this.name = 'SkillLimitError';
  }
}

/** Thrown when a bot is given a skill id that is not one of its own workspace's skills. */
export class UnknownSkillError extends Error {
  constructor(skillId: string) {
    super(`skill ${skillId} is not a skill of this workspace`);
    this.name = 'UnknownSkillError';
  }
}

/** The review-skill part of AppStore. Every call is scoped to one workspace. */
export interface ReviewSkillStore {
  /** The workspace's skills without their content, by name. */
  listReviewSkills(workspaceId: string): Promise<ReviewSkillSummary[]>;
  /** One skill with its content; null when it is not a skill of this workspace. */
  getReviewSkill(workspaceId: string, skillId: string): Promise<ReviewSkillRecord | null>;
  /** Throws SkillNameTakenError, SkillLimitError, or WorkspaceDeletedError. */
  createReviewSkill(workspaceId: string, skill: NewReviewSkill): Promise<ReviewSkillRecord>;
  /** Null when the skill is not in this workspace. Throws SkillNameTakenError. */
  updateReviewSkill(workspaceId: string, skillId: string, change: ReviewSkillChange): Promise<ReviewSkillRecord | null>;
  /**
   * Deletes the skill; the bots that used it fall back to Default and keep its name as
   * `skillRemovedName`. Null when the skill is not in this workspace.
   */
  deleteReviewSkill(workspaceId: string, skillId: string): Promise<DeletedReviewSkill | null>;
}

import { MAX_SKILL_NAME_LENGTH, MAX_SKILL_TOKENS } from '@mergepilot/engine';
import { z } from 'zod';
import { MAX_WORKSPACE_SKILLS } from '../core/skill-types.js';

// Review skills (ADR-0034): Markdown instructions a workspace admin uploads; each bot may use one.
// Re-exported by contract.ts.

export { MAX_SKILL_NAME_LENGTH, MAX_SKILL_TOKENS, MAX_WORKSPACE_SKILLS };

/** The request body of a skill write is capped well above 28,000 characters of any script. */
export const SKILL_BODY_LIMIT_BYTES = 128 * 1024;

export const SkillIdSchema = z.string().uuid('Skill id must be a uuid');

/** A skill name: trimmed, 1-60 characters; unique in the workspace ignoring case (checked by the API). */
export const SkillNameSchema = z
  .string()
  .trim()
  .min(1, 'Skill name is required')
  .max(MAX_SKILL_NAME_LENGTH, `Skill name must be at most ${MAX_SKILL_NAME_LENGTH} characters`);

/** The Markdown text; its size, text-ness and secrets are checked by the API (`checkSkillContent`). */
export const SkillContentSchema = z.string();

/** POST (admin) /api/workspaces/:workspaceId/skills */
export const CreateSkillBodySchema = z.object({ name: SkillNameSchema, content: SkillContentSchema });
export type CreateSkillBody = z.infer<typeof CreateSkillBodySchema>;

/** PUT (admin) /api/workspaces/:workspaceId/skills/:skillId: fields left out keep their value. */
export const UpdateSkillBodySchema = z
  .object({ name: SkillNameSchema.optional(), content: SkillContentSchema.optional() })
  .refine((body) => body.name !== undefined || body.content !== undefined, 'Send a name or content to change');
export type UpdateSkillBody = z.infer<typeof UpdateSkillBodySchema>;

/** A skill in the list: no content. `usedBy` lists the bot slots (1 = main bot) using it. */
export const SkillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  sizeTokens: z.number().int(),
  contentHash: z.string(),
  updatedAt: z.string(),
  usedBy: z.array(z.number().int()),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** GET (member) /api/workspaces/:workspaceId/skills */
export const SkillsResponseSchema = z.object({
  skills: z.array(SkillSummarySchema),
  limits: z.object({ maxSkills: z.number().int(), maxTokens: z.number().int(), maxNameLength: z.number().int() }),
});
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>;

/**
 * GET (member) /skills/:skillId, and the answer of POST and PUT (admin): one skill with its
 * content. DELETE (admin) answers 204; the bots that used it fall back to Default.
 */
export const SkillResponseSchema = z.object({ skill: SkillSummarySchema.extend({ content: z.string() }) });
export type SkillResponse = z.infer<typeof SkillResponseSchema>;

/** Error codes of the skill routes, for the dashboard's messages. */
export const SKILL_ERROR_CODES = [
  'skill_name_taken',
  'skill_limit',
  'skill_empty',
  'skill_too_large',
  'skill_not_text',
  'skill_has_credential',
  'unknown_skill',
] as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

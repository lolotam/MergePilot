import { randomUUID } from 'node:crypto';
import { checkSkillContent, estimateTokens, skillContentHash, skillNameHasCredential, type SkillContentProblem } from '@mergepilot/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import {
  MAIN_BOT_SLOT,
  SkillLimitError,
  SkillNameTakenError,
  WorkspaceDeletedError,
  type AppStore,
  type ReviewSkillSummary,
} from '../core/types.js';
import {
  CreateSkillBodySchema,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_TOKENS,
  MAX_WORKSPACE_SKILLS,
  SKILL_BODY_LIMIT_BYTES,
  UpdateSkillBodySchema,
  type SkillSummary,
  type SkillsResponse,
} from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';

const NAME_TAKEN = 'Another skill in this workspace already has this name';
export const NAME_CREDENTIAL = 'The skill name looks like a credential; choose another name';

/** The 400 answer for content `checkSkillContent` refused; a secret's value is never echoed. */
export function skillContentMessage(problem: SkillContentProblem): string {
  switch (problem.code) {
    case 'skill_empty':
      return 'The skill is empty';
    case 'skill_too_large':
      return `The skill is about ${problem.tokens} tokens; the limit is ${MAX_SKILL_TOKENS}`;
    case 'skill_not_text':
      return `Line ${problem.line} has a character that is not plain text; upload a UTF-8 Markdown file`;
    case 'skill_has_credential':
      return `Line ${problem.line} looks like a credential; remove it before uploading`;
  }
}

/** The bot slots (1 = main bot) using each skill of the workspace. */
export async function skillUsage(store: AppStore, workspaceId: string): Promise<Map<string, number[]>> {
  const [settings, bots] = await Promise.all([store.getSettings(workspaceId), store.listReviewerBots(workspaceId)]);
  const usage = new Map<string, number[]>();
  const add = (skillId: string | null | undefined, slot: number) => {
    if (skillId) usage.set(skillId, [...(usage.get(skillId) ?? []), slot]);
  };
  add(settings?.skillId, MAIN_BOT_SLOT);
  for (const bot of [...bots].sort((a, b) => a.slot - b.slot)) add(bot.skillId, bot.slot);
  return usage;
}

function toSummary(skill: ReviewSkillSummary, usage: Map<string, number[]>): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    sizeTokens: skill.sizeTokens,
    contentHash: skill.contentHash,
    updatedAt: skill.updatedAt.toISOString(),
    usedBy: usage.get(skill.id) ?? [],
  };
}

/**
 * Review skills (ADR-0034): members read, admins and owners write. Every route is scoped to the
 * URL's workspace; logs carry the skill id and name, never the content.
 */
export function registerSkillRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  app.get(
    '/api/workspaces/:workspaceId/skills',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const [skills, usage] = await Promise.all([deps.store.listReviewSkills(workspaceId), skillUsage(deps.store, workspaceId)]);
      const body: SkillsResponse = {
        skills: skills.map((skill) => toSummary(skill, usage)),
        limits: { maxSkills: MAX_WORKSPACE_SKILLS, maxTokens: MAX_SKILL_TOKENS, maxNameLength: MAX_SKILL_NAME_LENGTH },
      };
      return reply.status(200).send(body);
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/skills/:skillId',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const skill = await deps.store.getReviewSkill(workspaceId, skillId);
      if (!skill) return sendError(reply, 404, 'not_found', 'Skill not found');
      const usage = await skillUsage(deps.store, workspaceId);
      return reply.status(200).send({ skill: { ...toSummary(skill, usage), content: skill.content } });
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/skills',
    { preHandler: [requireRole('admin', deps.auth)], bodyLimit: SKILL_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const parsed = CreateSkillBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid skill');
      const { name, content } = parsed.data;
      if (skillNameHasCredential(name)) return sendError(reply, 400, 'skill_has_credential', NAME_CREDENTIAL);
      const problem = checkSkillContent(content);
      if (problem) return sendError(reply, 400, problem.code, skillContentMessage(problem));
      try {
        const skill = await deps.store.createReviewSkill(workspaceId, {
          id: randomUUID(),
          name,
          content,
          contentHash: skillContentHash(content),
          sizeTokens: estimateTokens(content),
          userId: request.auth?.userId ?? '',
        });
        request.log.info({ event: 'skill.created', workspaceId, skillId: skill.id, name: skill.name }, 'Review skill created');
        return reply.status(201).send({ skill: { ...toSummary(skill, new Map()), content: skill.content } });
      } catch (error) {
        if (error instanceof SkillNameTakenError) return sendError(reply, 409, 'skill_name_taken', NAME_TAKEN);
        if (error instanceof SkillLimitError) {
          return sendError(reply, 409, 'skill_limit', `A workspace can have at most ${MAX_WORKSPACE_SKILLS} skills`);
        }
        if (error instanceof WorkspaceDeletedError) return sendError(reply, 404, 'not_found', 'Workspace not found');
        throw error;
      }
    },
  );

  app.put(
    '/api/workspaces/:workspaceId/skills/:skillId',
    { preHandler: [requireRole('admin', deps.auth)], bodyLimit: SKILL_BODY_LIMIT_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const parsed = UpdateSkillBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid skill');
      const { name, content } = parsed.data;
      if (name !== undefined && skillNameHasCredential(name)) return sendError(reply, 400, 'skill_has_credential', NAME_CREDENTIAL);
      if (content !== undefined) {
        const problem = checkSkillContent(content);
        if (problem) return sendError(reply, 400, problem.code, skillContentMessage(problem));
      }
      const previous = await deps.store.getReviewSkill(workspaceId, skillId);
      if (!previous) return sendError(reply, 404, 'not_found', 'Skill not found');
      try {
        const skill = await deps.store.updateReviewSkill(workspaceId, skillId, {
          name,
          content: content === undefined
            ? undefined
            : { text: content, hash: skillContentHash(content), sizeTokens: estimateTokens(content) },
          userId: request.auth?.userId ?? '',
        });
        if (!skill) return sendError(reply, 404, 'not_found', 'Skill not found');
        request.log.info(
          {
            event: 'skill.updated',
            workspaceId,
            skillId,
            name: skill.name,
            changedFields: [
              ...(skill.name !== previous.name ? ['name'] : []),
              ...(skill.contentHash !== previous.contentHash ? ['content'] : []),
            ],
          },
          'Review skill updated',
        );
        const usage = await skillUsage(deps.store, workspaceId);
        return reply.status(200).send({ skill: { ...toSummary(skill, usage), content: skill.content } });
      } catch (error) {
        if (error instanceof SkillNameTakenError) return sendError(reply, 409, 'skill_name_taken', NAME_TAKEN);
        if (error instanceof WorkspaceDeletedError) return sendError(reply, 404, 'not_found', 'Workspace not found');
        throw error;
      }
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/skills/:skillId',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId, skillId } = request.params as { workspaceId: string; skillId: string };
      const deleted = await deps.store.deleteReviewSkill(workspaceId, skillId);
      if (!deleted) return sendError(reply, 404, 'not_found', 'Skill not found');
      request.log.info(
        { event: 'skill.deleted', workspaceId, skillId, name: deleted.name, fellBackSlots: deleted.fellBackSlots },
        'Review skill deleted; the bots that used it now review with the core prompt only',
      );
      return reply.status(204).send();
    },
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRole } from '../auth/guard.js';
import {
  BOT_LOGOS,
  BotNameTakenError,
  DEFAULT_BOT_LOGO,
  DEFAULT_BOT_NAME,
  DEFAULT_PANEL_MIN_AGREEMENT,
  DEFAULT_PANEL_MODE,
  InvalidBotSlotError,
  isExtraBotSlot,
  MAX_EXTRA_BOT_SLOT,
  MIN_EXTRA_BOT_SLOT,
  UnknownSkillError,
  WorkspaceDeletedError,
  type ReviewerBot,
} from '../core/types.js';
import { ReviewerBotInputSchema, type BotsResponse } from './contract.js';
import { sendError } from './helpers.js';
import type { DashboardApiDeps } from './routes.js';
import { unavailableProviderProblem, unknownSkillProblem, validateFallback } from './settings-validation.js';
import { subscriptionAvailability } from './subscription-routes.js';

const SLOT_MESSAGE = `Bot slot must be ${MIN_EXTRA_BOT_SLOT}-${MAX_EXTRA_BOT_SLOT} (slot 1 is the main bot, set in the settings)`;

/** The `:slot` route param as an extra bot slot (2-5), or null. */
function parseSlot(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const slot = Number(raw);
  return isExtraBotSlot(slot) ? slot : null;
}

/**
 * Reviewer panel routes (ADR-0017): the main bot (slot 1, from the workspace settings) and up to
 * four extra bots (slots 2-5). Members read; admins and owners write. The main bot's name, logo
 * and the panel mode are saved with the settings (PUT /settings).
 */
export function registerBotRoutes(app: FastifyInstance, deps: DashboardApiDeps): void {
  app.get(
    '/api/workspaces/:workspaceId/bots',
    { preHandler: [requireRole('member', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { workspaceId } = request.params as { workspaceId: string };
      const [settings, bots] = await Promise.all([
        deps.store.getSettings(workspaceId),
        deps.store.listReviewerBots(workspaceId),
      ]);
      const body: BotsResponse = {
        main: {
          slot: 1,
          name: settings?.botName ?? DEFAULT_BOT_NAME,
          logo: settings?.botLogo ?? DEFAULT_BOT_LOGO,
          active: true,
          provider: settings?.provider ?? null,
          model: settings?.model ?? null,
          effort: settings?.effort ?? null,
          fallback: settings?.fallback ?? [],
          exploreEnabled: settings?.exploreEnabled ?? false,
          ...(settings?.skillId ? { skillId: settings.skillId } : {}),
          ...(settings?.skillRemovedName ? { skillRemovedName: settings.skillRemovedName } : {}),
        },
        bots: bots.map((bot) => ({ ...bot, exploreEnabled: bot.exploreEnabled ?? false })),
        panel: {
          mode: settings?.panelMode ?? DEFAULT_PANEL_MODE,
          minAgreement: settings?.panelMinAgreement ?? DEFAULT_PANEL_MIN_AGREEMENT,
        },
        logos: [...BOT_LOGOS],
      };
      return reply.status(200).send(body);
    },
  );

  app.put(
    '/api/workspaces/:workspaceId/bots/:slot',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { workspaceId: string; slot: string };
      const { workspaceId } = params;
      const slot = parseSlot(params.slot);
      if (slot === null) return sendError(reply, 400, 'invalid_slot', SLOT_MESSAGE);
      const parsed = ReviewerBotInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid bot');
      }
      const input = parsed.data;
      const previous = (await deps.store.listReviewerBots(workspaceId)).find((b) => b.slot === slot) ?? null;
      // ADR-0034: a skill left out keeps the stored one (and its deleted-skill note); any choice,
      // null (Default) included, clears the note.
      // Left out, the store keeps the stored skill and its note inside the write, so a concurrent
      // change is not overwritten by what this request read earlier.
      const skillChoice = input.skillId !== undefined ? { skillId: input.skillId, skillRemovedName: null } : {};
      const bot: ReviewerBot = {
        slot,
        name: input.name,
        logo: input.logo,
        active: input.active,
        provider: input.provider,
        model: input.model,
        effort: input.effort ?? null,
        fallback: input.fallback,
        exploreEnabled: input.exploreEnabled,
        ...skillChoice,
      };
      const problem = unavailableProviderProblem(bot, previous, subscriptionAvailability(deps))
        ?? await validateFallback(deps.store, workspaceId, bot, bot.fallback)
        ?? await unknownSkillProblem(deps.store, workspaceId, input.skillId);
      if (problem) return sendError(reply, 400, problem.code, problem.message);

      let saved: ReviewerBot;
      try {
        saved = await deps.store.upsertReviewerBot(workspaceId, bot);
      } catch (err) {
        if (err instanceof BotNameTakenError) {
          return sendError(reply, 409, 'bot_name_taken', 'Another bot in this workspace already has this name');
        }
        if (err instanceof InvalidBotSlotError) return sendError(reply, 400, 'invalid_slot', SLOT_MESSAGE);
        if (err instanceof UnknownSkillError) return sendError(reply, 400, 'unknown_skill', err.message);
        if (err instanceof WorkspaceDeletedError) return sendError(reply, 404, 'not_found', 'Workspace not found');
        throw err;
      }
      request.log.info(
        {
          event: previous ? 'bot.updated' : 'bot.created',
          workspaceId,
          slot,
          active: saved.active,
          provider: saved.provider,
          model: saved.model,
          // Only fields whose stored value really changed (forms resend unchanged values).
          changedFields: (Object.keys(saved) as Array<keyof ReviewerBot>).filter(
            (key) => JSON.stringify(previous?.[key] ?? null) !== JSON.stringify(saved[key]),
          ),
        },
        previous ? 'Reviewer bot updated' : 'Reviewer bot created',
      );
      return reply.status(200).send({ bot: saved });
    },
  );

  app.delete(
    '/api/workspaces/:workspaceId/bots/:slot',
    { preHandler: [requireRole('admin', deps.auth)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { workspaceId: string; slot: string };
      const slot = parseSlot(params.slot);
      if (slot === null) return sendError(reply, 400, 'invalid_slot', SLOT_MESSAGE);
      const deleted = await deps.store.deleteReviewerBot(params.workspaceId, slot);
      if (!deleted) return sendError(reply, 404, 'not_found', `No bot in slot ${slot}`);
      request.log.info({ event: 'bot.deleted', workspaceId: params.workspaceId, slot }, 'Reviewer bot deleted');
      return reply.status(204).send();
    },
  );
}

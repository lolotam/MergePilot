import { z } from 'zod';
import {
  BOT_LOGOS,
  MAX_BOT_NAME_LENGTH,
  MAX_EXTRA_BOT_SLOT,
  PANEL_MODES,
  type BotLogo,
  type PanelMode,
} from '../core/bot-types.js';
import {
  ApiProviderSchema,
  EffortSchema,
  FallbackEntrySchema,
  MAX_FALLBACK_MODELS,
  ModelIdSchema,
} from './contract-models.js';
import { SkillIdSchema } from './contract-skills.js';
import { CallTimeoutMsSchema } from './contract-call-timeout.js';

// The reviewer panel (ADR-0017): up to five bots per workspace. Re-exported by contract.ts.

export { BOT_LOGOS, MAX_EXTRA_BOT_SLOT, PANEL_MODES, type BotLogo, type PanelMode };

/** A bot name: trimmed, 1-40 characters; unique in the workspace ignoring case (checked by the API). */
export const BotNameSchema = z.string().trim().min(1, 'Bot name is required').max(MAX_BOT_NAME_LENGTH, `Bot name must be at most ${MAX_BOT_NAME_LENGTH} characters`);
export const BotLogoSchema = z.enum(BOT_LOGOS, { message: `Bot logo must be one of: ${BOT_LOGOS.join(', ')}` });
export const PanelModeSchema = z.enum(PANEL_MODES);
export const PanelMinAgreementSchema = z.number().int().min(1).max(5);

/** PUT (admin) /api/workspaces/:workspaceId/bots/:slot (slot 2-5): creates or replaces an extra bot. */
export const ReviewerBotInputSchema = z.object({
  name: BotNameSchema,
  logo: BotLogoSchema,
  active: z.boolean().optional().default(true),
  provider: ApiProviderSchema,
  model: ModelIdSchema,
  effort: EffortSchema.nullable().optional(),
  fallback: z.array(FallbackEntrySchema).max(MAX_FALLBACK_MODELS).optional().default([]),
  /** Read-only exploration; left out keeps the stored value, a new bot starts off (ADR-0046). */
  exploreEnabled: z.boolean().optional(),
  /** The bot's review skill (ADR-0034); null = Default. Left out keeps the stored skill. */
  skillId: SkillIdSchema.nullable().optional(),
  /** Migration 0018: the bot's optional call timeout override in ms (1000-1200000); omitted keeps the stored one, null resets to inherit. */
  callTimeoutMs: CallTimeoutMsSchema.optional(),
});
export type ReviewerBotInput = z.infer<typeof ReviewerBotInputSchema>;

export const ReviewerBotSchema = z.object({
  slot: z.number().int().min(1).max(MAX_EXTRA_BOT_SLOT),
  name: z.string(),
  logo: BotLogoSchema,
  active: z.boolean(),
  provider: ApiProviderSchema,
  model: z.string(),
  effort: z.string().nullable(),
  fallback: z.array(FallbackEntrySchema),
  exploreEnabled: z.boolean(),
  /** The bot's review skill (ADR-0034); left out on Default. */
  skillId: z.string().nullable().optional(),
  /** The name of the bot's skill that was deleted; left out unless the bot fell back to Default. */
  skillRemovedName: z.string().nullable().optional(),
  /** Migration 0018: the bot's optional call timeout override in ms (1000-1200000); omitted keeps the stored one, null = inherit. */
  callTimeoutMs: CallTimeoutMsSchema.optional(),
});
export type ReviewerBotDto = z.infer<typeof ReviewerBotSchema>;

/**
 * GET (member) /api/workspaces/:workspaceId/bots. `main` is slot 1 (the workspace settings, always
 * active); its provider and model are null until the settings are saved. `bots` are the extra bots
 * sorted by slot; `logos` are the preset logo keys.
 */
export const BotsResponseSchema = z.object({
  main: ReviewerBotSchema.extend({
    slot: z.literal(1),
    active: z.literal(true),
    provider: ApiProviderSchema.nullable(),
    model: z.string().nullable(),
  }),
  bots: z.array(ReviewerBotSchema),
  panel: z.object({ mode: PanelModeSchema, minAgreement: z.number().int() }),
  logos: z.array(BotLogoSchema),
});
export type BotsResponse = z.infer<typeof BotsResponseSchema>;

/** PUT /bots/:slot answers `{ bot }`; DELETE (admin) /bots/:slot answers 204, or 404 when the slot is empty. */
export const SaveBotResponseSchema = z.object({ bot: ReviewerBotSchema });

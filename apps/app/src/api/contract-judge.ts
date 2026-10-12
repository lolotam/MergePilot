import { z } from 'zod';
import {
  API_PROVIDER_IDS,
  JUDGE_KEY_ONLY_PROVIDER_IDS,
  JUDGE_MODES,
  JUDGE_PROVIDER_IDS,
  MAX_JUDGE_FALLBACKS,
} from '@mergepilot/engine';

/**
 * The Jev judge part of the dashboard contract (ADR-0015). Jev-only models are checked by the
 * settings validation against the engine's fixed model table, which the catalog route serves.
 */

/** Every provider a workspace can store a key for: review providers plus the Jev-only key types. */
export const KeyProviderSchema = z.enum([...API_PROVIDER_IDS, ...JUDGE_KEY_ONLY_PROVIDER_IDS]);
export type KeyProvider = z.infer<typeof KeyProviderSchema>;

export const JudgeProviderSchema = z.enum(JUDGE_PROVIDER_IDS);
export type JudgeProvider = z.infer<typeof JudgeProviderSchema>;
export const JudgeModeSchema = z.enum(JUDGE_MODES);
export type JudgeMode = z.infer<typeof JudgeModeSchema>;

const JevModelIdSchema = z.string().trim().min(1).max(200);

export const JudgeFallbackSettingSchema = z.object({
  provider: JudgeProviderSchema,
  model: JevModelIdSchema,
});

/** Part of PUT settings (admin): left out keeps the stored judge, null turns it off and clears it. */
export const JudgeSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: JudgeProviderSchema,
  model: JevModelIdSchema,
  mode: JudgeModeSchema,
  threshold: z.number().min(0).max(1),
  fallback: z.array(JudgeFallbackSettingSchema).max(MAX_JUDGE_FALLBACKS).default([]),
});
export type JudgeSettings = z.infer<typeof JudgeSettingsSchema>;

/** GET (member) /api/workspaces/:workspaceId/judge/providers — the fixed Jev-only model table. */
export const JudgeProvidersResponseSchema = z.object({
  providers: z.array(
    z.object({
      id: JudgeProviderSchema,
      label: z.string(),
      models: z.array(z.string()),
      /** True for providers whose key serves only the judge (TypeSafe, Vercel AI Gateway). */
      keyOnly: z.boolean(),
    }),
  ),
});
export type JudgeProvidersResponse = z.infer<typeof JudgeProvidersResponseSchema>;

/**
 * POST (admin) /api/workspaces/:workspaceId/judge/test — sends one tiny `noul` question with the
 * stored key, or with an unsaved `apiKey` (test before saving; never stored, logged or echoed).
 * Answers like the connection test: `{ok, ms, model}` or `{ok: false, code, message}`.
 */
export const JudgeTestBodySchema = z.object({
  provider: JudgeProviderSchema,
  model: JevModelIdSchema.optional(),
  apiKey: z.string().max(500).optional(),
});

export const JudgeAttemptSchema = z.object({
  provider: z.string(),
  model: z.string(),
  ok: z.boolean(),
  code: z.string().optional(),
  ms: z.number(),
  skipped: z.boolean().optional(),
});

/** `result.judge` of a run: what the judge did, every attempt, and its own tokens and cost. */
export const JudgeRunSchema = z.object({
  mode: JudgeModeSchema,
  threshold: z.number(),
  checked: z.number(),
  filtered: z.array(z.object({ title: z.string(), path: z.string(), line: z.number(), noul: z.number() })),
  duplicatesDropped: z.number(),
  /** "provider:model (fallback n; … failed: code)" of the entry that answered. */
  answeredBy: z.string().optional(),
  unavailable: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
  attempts: z.array(JudgeAttemptSchema),
});
export type JudgeRun = z.infer<typeof JudgeRunSchema>;

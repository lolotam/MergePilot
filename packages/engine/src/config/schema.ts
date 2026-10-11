import { z } from 'zod';
import { SeveritySchema } from '../review/types.js';

export const ProviderSchema = z.enum(['anthropic', 'openai', 'gemini', 'claude-code']);
export type Provider = z.infer<typeof ProviderSchema>;

const PathInstructionSchema = z.strictObject({
  path: z.string().min(1),
  instructions: z.string().min(1),
});

const ReviewSettingsSchema = z.strictObject({
  maxFindings: z.number().int().min(1).max(20).default(5),
  minSeverity: SeveritySchema.default('medium'),
  exclude: z.array(z.string()).default(['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap']),
  rulesFiles: z.array(z.string()).default(['CLAUDE.md', 'AGENTS.md']),
  pathInstructions: z.array(PathInstructionSchema).default([]),
});

export const ModelPricingSchema = z
  .strictObject({
    inputPerMTok: z.number().min(0),
    outputPerMTok: z.number().min(0),
    cacheReadPerMTok: z.number().min(0).optional(),
    cacheWritePerMTok: z.number().min(0).optional(),
  })
  .transform((val) => ({
    inputPerMTok: val.inputPerMTok,
    outputPerMTok: val.outputPerMTok,
    cacheReadPerMTok: val.cacheReadPerMTok ?? val.inputPerMTok,
    cacheWritePerMTok: val.cacheWritePerMTok ?? val.inputPerMTok,
  }));

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

const BudgetSchema = z.strictObject({
  perReviewUsd: z.number().positive().default(0.5),
  maxInputTokens: z.number().int().positive().default(200000),
  pricing: ModelPricingSchema.optional(),
});

const AuditSchema = z.strictObject({
  enabled: z.boolean().default(false),
  schedule: z.string().min(1).optional(),
});

/**
 * `.mergepilot.yml`. Strict at every level so a typo surfaces as an error instead of
 * silently falling back to a default. `claude-code` runs the official CLI on the user's
 * own subscription (ADR-0006) and picks its model itself, so `model` is optional there.
 */
export const MergePilotConfigSchema = z
  .strictObject({
    provider: ProviderSchema,
    model: z.string().min(1).optional(),
    language: z.enum(['ar', 'en']).default('ar'),
    review: ReviewSettingsSchema.prefault({}),
    budget: BudgetSchema.prefault({}),
    audit: AuditSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.provider !== 'claude-code' && config.model === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: `required when provider is ${config.provider}`,
      });
    }
  });

export type MergePilotConfig = z.infer<typeof MergePilotConfigSchema>;

import { z } from 'zod';
import { JudgeConfigSchema } from '../judge/config.js';
import { API_PROVIDER_IDS, PROVIDER_IDS } from '../providers/ids.js';
import { SeveritySchema } from '../review/types.js';

export const ProviderSchema = z.enum(PROVIDER_IDS);
export type Provider = z.infer<typeof ProviderSchema>;

/** Providers called with a customer-owned API key; everything except `claude-code`. */
export const ApiProviderSchema = z.enum(API_PROVIDER_IDS);

const BaseUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * `baseUrl` in a repository file is untrusted (anyone who can change the file could point a
 * customer key at their own server), so it is never used to send a request (ADR-0008
 * amendment). Presets reject it outright; `custom` tolerates it only so an existing file still
 * parses, and the engine ignores it: the custom server URL comes from a trusted source only
 * (the Action's `custom-base-url` input / `CUSTOM_LLM_BASE_URL`, or workspace settings).
 */
const BASE_URL_NOT_ALLOWED =
  'baseUrl is not allowed here: preset providers always use their fixed API URL, and only provider "custom" may name one (set its URL through the trusted CUSTOM_LLM_BASE_URL / custom-base-url input, not this file)';

function rejectPresetBaseUrl(entry: { provider: string; baseUrl?: string | undefined }, ctx: z.RefinementCtx): void {
  if (entry.provider !== 'custom' && entry.baseUrl !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: BASE_URL_NOT_ALLOWED });
  }
}

/**
 * One explicit fallback model (ADR-0008). Tried in order, only when the model before it failed
 * after its retries with quota / rate-limit / server / network / auth, and always disclosed.
 */
export const FallbackEntrySchema = z
  .strictObject({
    provider: ApiProviderSchema,
    model: z.string().min(1),
    effort: z.string().min(1).optional(),
    /** Untrusted and ignored; rejected for presets (see BASE_URL_NOT_ALLOWED). */
    baseUrl: BaseUrlSchema.optional(),
  })
  .superRefine(rejectPresetBaseUrl);
export type FallbackEntry = z.infer<typeof FallbackEntrySchema>;

export const MAX_FALLBACK_MODELS = 3;

const PathInstructionSchema = z.strictObject({
  path: z.string().min(1),
  instructions: z.string().min(1),
});

/**
 * Limits that keep a huge PR from failing as a whole (ADR-0013). Exported so the pipeline can
 * apply the same defaults to a config built in code without going through the schema.
 */
export interface ReviewLimits {
  maxPromptTokens: number;
  batchTokens: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
}

export const REVIEW_LIMIT_DEFAULTS: Readonly<ReviewLimits> = Object.freeze({
  maxPromptTokens: 120_000,
  batchTokens: 24_000,
  callTimeoutMs: 300_000,
  totalTimeoutMs: 1_200_000,
});

/** Default `review.maxRulesTokens` (ADR-0028). */
export const DEFAULT_MAX_RULES_TOKENS = 12_000;

/** Default `review.contextTokens` (ADR-0029). */
export const DEFAULT_CONTEXT_TOKENS = 30_000;

const ReviewSettingsSchema = z.strictObject({
  maxFindings: z.number().int().min(1).max(20).default(5),
  minSeverity: SeveritySchema.default('medium'),
  exclude: z.array(z.string()).default(['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap']),
  rulesFiles: z.array(z.string()).default(['CLAUDE.md', 'AGENTS.md']),
  /**
   * Total estimated tokens of owner rules sent with a review. The configured `rulesFiles` always go;
   * the nested AGENTS.md / CLAUDE.md of changed directories fill what is left, shallowest and
   * smallest first, and the ones left out are disclosed in the summary (ADR-0028).
   */
  maxRulesTokens: z.number().int().positive().default(DEFAULT_MAX_RULES_TOKENS),
  /**
   * Estimated tokens of repository context (files outside the diff, read at the PR head) per review
   * call: the whole-PR call gets up to this much; each batch up to `min(contextTokens, batchTokens)`
   * from its own files. 0 turns it off. What is left out is counted in the summary (ADR-0029).
   */
  contextTokens: z.number().int().min(0).default(DEFAULT_CONTEXT_TOKENS),
  pathInstructions: z.array(PathInstructionSchema).default([]),
  /** Second model pass that re-checks every finding against the code before publishing. */
  verify: z.boolean().default(true),
  libraryDocs: z
    .strictObject({
      /** npm = README of the exact installed version; context7 = opt-in third-party service. */
      source: z.enum(['npm', 'context7', 'none']).default('npm'),
      maxCharsPerLibrary: z.number().int().min(500).max(50000).default(8000),
      maxLibraries: z.number().int().min(0).max(20).default(5),
    })
    .prefault({}),
  /** Above this estimated prompt size the single whole-PR call is skipped: the PR goes straight to batches. */
  maxPromptTokens: z.number().int().positive().default(REVIEW_LIMIT_DEFAULTS.maxPromptTokens),
  /** Diff tokens per batch; a single file bigger than this is its own batch, its patch truncated. */
  batchTokens: z.number().int().positive().default(REVIEW_LIMIT_DEFAULTS.batchTokens),
  /** Timeout of every single model call, retries included. */
  callTimeoutMs: z.number().int().positive().default(REVIEW_LIMIT_DEFAULTS.callTimeoutMs),
  /** Overall review time: once reached, no new batch starts and the review finishes with what is done. */
  totalTimeoutMs: z.number().int().positive().default(REVIEW_LIMIT_DEFAULTS.totalTimeoutMs),
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

/** Default `budget.maxInputTokens` (ADR-0013 amendment, eyadex#78). */
export const DEFAULT_MAX_INPUT_TOKENS = 1_000_000;

const BudgetSchema = z.strictObject({
  perReviewUsd: z.number().positive().default(0.5),
  /**
   * Whole-PR cap on the estimated prompt. Huge PRs are reviewed in capped batches (ADR-0013), so
   * this only stops absurd PRs; each model call stays bounded by `review.batchTokens`.
   */
  maxInputTokens: z.number().int().positive().default(DEFAULT_MAX_INPUT_TOKENS),
  pricing: ModelPricingSchema.optional(),
});

export const AuditSchema = z.strictObject({
  enabled: z.boolean().default(false),
  schedule: z.string().min(1).optional(),
  output: z.enum(['summary', 'issue']).default('summary'),
  maxFiles: z.number().int().positive().default(200),
  include: z.array(z.string()).default(['**/*']),
  exclude: z
    .array(z.string())
    .default(['**/*.lock', '**/dist/**', '**/*.min.*', '**/*.snap', 'docs/**']),
});

export type AuditConfig = z.infer<typeof AuditSchema>;

/**
 * `.mergepilot.yml`. Strict at every level so a typo surfaces as an error instead of
 * silently falling back to a default. `claude-code` runs the official CLI on the user's
 * own subscription (ADR-0006) and picks its model itself, so `model` is optional there.
 */
export const MergePilotConfigSchema = z
  .strictObject({
    provider: ProviderSchema,
    model: z.string().min(1).optional(),
    /** Thinking effort for `model` (e.g. low / medium / high / off); ignored where unknown. */
    effort: z.string().min(1).optional(),
    /** Untrusted and ignored; rejected for presets (see BASE_URL_NOT_ALLOWED). */
    baseUrl: BaseUrlSchema.optional(),
    /** Explicit, disclosed fallback models (ADR-0008); empty means no fallback at all. */
    fallback: z.array(FallbackEntrySchema).max(MAX_FALLBACK_MODELS).default([]),
    language: z.enum(['ar', 'en']).default('ar'),
    review: ReviewSettingsSchema.prefault({}),
    budget: BudgetSchema.prefault({}),
    audit: AuditSchema.prefault({}),
    /** Optional Jev judge (ADR-0015): false-positive filter and semantic duplicate check. */
    judge: JudgeConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if (config.provider !== 'claude-code' && config.model === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: `required when provider is ${config.provider}`,
      });
    }
    rejectPresetBaseUrl(config, ctx);
  });

export type MergePilotConfig = z.infer<typeof MergePilotConfigSchema>;

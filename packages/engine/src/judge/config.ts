/**
 * The `judge:` section of `.mergepilot.yml` (ADR-0015). Strict like the rest of the file: no
 * `baseUrl` anywhere (the endpoints are fixed), and every model must be one of the provider's
 * Jev models. Keys come from the environment (`JUDGE_PROVIDERS[provider].envName`).
 *
 * `uses` (multi-use amendment) replaces the old single `mode`, which is still accepted and mapped
 * (`judgeUsesFromMode`); when both are given, `uses` wins. Neither means the old default `off`,
 * i.e. the duplicate check only.
 */
import { z } from 'zod';
import { DEFAULT_JUDGE_THRESHOLD } from './false-positive.js';
import { MAX_JUDGE_FALLBACKS } from './judge.js';
import { defaultJevModel, isJevModel, JUDGE_PROVIDER_IDS, jevModelIds } from './providers.js';
import { JUDGE_MODES, JUDGE_USES, judgeUsesFromMode, normalizeJudgeUses } from './uses.js';

const JudgeProviderSchema = z.enum(JUDGE_PROVIDER_IDS);

function checkJevModel(entry: { provider: (typeof JUDGE_PROVIDER_IDS)[number]; model?: string | undefined }, ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (entry.model !== undefined && !isJevModel(entry.provider, entry.model)) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'model'],
      message: `${entry.provider} offers only these Jev models: ${jevModelIds(entry.provider).join(', ')}`,
    });
  }
}

export const JudgeFallbackEntrySchema = z.strictObject({
  provider: JudgeProviderSchema,
  model: z.string().min(1).optional(),
});

export const JudgeConfigSchema = z
  .strictObject({
    provider: JudgeProviderSchema,
    /** Defaults to the provider's first Jev model. */
    model: z.string().min(1).optional(),
    uses: z.array(z.enum(JUDGE_USES)).optional(),
    /** Before multi-use: off | annotate | filter. Mapped to `uses`; ignored when `uses` is given. */
    mode: z.enum(JUDGE_MODES).optional(),
    threshold: z.number().min(0).max(1).default(DEFAULT_JUDGE_THRESHOLD),
    /** Explicit, disclosed fallbacks tried in order when the judge before them fails. */
    fallback: z.array(JudgeFallbackEntrySchema).max(MAX_JUDGE_FALLBACKS).default([]),
  })
  .superRefine((judge, ctx) => {
    checkJevModel(judge, ctx, []);
    judge.fallback.forEach((entry, index) => checkJevModel(entry, ctx, ['fallback', index]));
  })
  .transform(({ mode, uses, ...judge }) => ({
    ...judge,
    uses: normalizeJudgeUses(uses ?? judgeUsesFromMode(mode ?? 'off')),
  }));

export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

/** The configured judge and its fallbacks as `{provider, model}` entries, models defaulted. */
export function judgeChainOf(judge: JudgeConfig): Array<{ provider: (typeof JUDGE_PROVIDER_IDS)[number]; model: string }> {
  return [judge, ...judge.fallback].map((entry) => ({
    provider: entry.provider,
    model: entry.model ?? defaultJevModel(entry.provider),
  }));
}

import type { Secret } from '@mergepilot/engine';
import type { SemanticDedupeResult } from '@mergepilot/github';
import type { RunPricing } from '../core/price-types.js';
import type { FinishReviewRunOptions, ReviewRunResultPayload, ReviewRunStatus } from '../core/types.js';
import type { ApiEquivalentPrice } from './api-equivalent.js';
import type { ReviewOnlyOutcome } from './bot-review-run.js';
import { judgeRunParts, type WorkspaceJudge } from './judge-setup.js';
import type { KeyRotationDisclosure } from './key-roster.js';
import { usedModel, type ModelChoice } from './model-choice.js';
import type { BotRun, PanelContext } from './panel-types.js';
import { prepareRunResult } from './prepare-run-result.js';
import { equivalentFields, type SubscriptionUsage } from './subscription-equivalent.js';
import type { ProcessReviewResult } from './types.js';

export interface RecordPricing {
  /** What priced the bot's own model (ADR-0016). */
  pricing: RunPricing;
  /** The display-only API price of a subscription or token-plan model (ADR-0024). */
  apiPrice: ApiEquivalentPrice | undefined;
  rotation: readonly KeyRotationDisclosure[];
  /** The primary model runs on a consumer subscription. */
  onSubscription: boolean;
}

export interface BotRecord {
  finish: FinishReviewRunOptions;
  result: ProcessReviewResult;
  modelLabel: string;
}

/** The run record of a reviewed bot: status, cost, detail, the model that answered, findings. */
export async function recordOf(
  ctx: PanelContext,
  br: BotRun,
  choice: ModelChoice,
  review: ReviewOnlyOutcome & { judgeSemantic?: SemanticDedupeResult | undefined },
  judgeSetup: WorkspaceJudge,
  knownSecrets: Secret[],
  skippedNote: string | undefined,
  { pricing, apiPrice, rotation, onSubscription }: RecordPricing,
): Promise<BotRecord> {
  // `subscription` ($0) only while every call stayed on a subscription; a run that switched to
  // paid API keys is priced at the API price (ADR-0027). A run that made no model call has no
  // tally, and without a fallback all its calls were on the primary.
  const rr = review.runResult;
  const allOnSubscription =
    rr && rr.status !== 'skipped-budget' ? rr.onlySubscriptionCalls : onSubscription && !review.fallbackFrom;
  const runPricing: RunPricing = allOnSubscription ? { source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 } : pricing;
  const subscriptionUsage: SubscriptionUsage | undefined =
    rr && rr.status !== 'skipped-budget' ? rr.subscriptionUsage : undefined;
  const runUsage = rr && rr.status !== 'skipped-budget' ? rr.usage : undefined;
  // The display-only API-equivalent of the run (ADR-0024): the API price of its own tokens, or
  // the per-model price of its subscription calls when it mixed methods or models (ADR-0047).
  const equivalent = await equivalentFields(
    {
      usage: runUsage,
      apiPrice,
      subscriptionUsage,
      onlySubscriptionCalls: allOnSubscription,
      fellBack: review.fallbackFrom !== undefined,
      switchedMethod: review.fallbackFromMethod !== undefined,
      subscriptionUsageUnreported: rr !== undefined && rr.status !== 'skipped-budget' && rr.subscriptionUsageUnreported === true,
      store: ctx.deps.store,
      settings: ctx.settings,
    },
    (error: unknown) => {
      ctx.logger.warn(
        { event: 'review.api_equivalent_failed', jobId: ctx.job.deliveryId, runId: br.run.id, error: error instanceof Error ? error.name : 'unknown' },
        'Could not price the API-equivalent; the run shows none',
      );
    },
  );
  // What priced this bot's own model (ADR-0016), plus the display-only API-equivalent of a
  // subscription or token-plan run (ADR-0024), from its own usage before the judge's tokens; the
  // method switch (ADR-0027) and the key rotation (ADR-0026). Never a secret or provider text.
  const disclosed = (): Pick<ReviewRunResultPayload, 'pricing' | 'fallbackFromMethod' | 'modelUsedMethod' | 'keyRotation'> => ({
    pricing: { ...runPricing, ...equivalent },
    ...(review.fallbackFromMethod && review.modelUsedMethod
      ? { fallbackFromMethod: review.fallbackFromMethod, modelUsedMethod: review.modelUsedMethod }
      : {}),
    ...(rotation.length > 0 ? { keyRotation: rotation.slice(0, 20).map((event) => ({ ...event })) } : {}),
  });
  const status: ReviewRunStatus =
    review.outcome === 'completed'
      ? 'completed'
      : review.outcome === 'skipped-budget' || review.outcome === 'skipped'
        ? 'skipped'
        : 'failed';

  const costUsd = review.costUsd ?? null;
  let payload: ReviewRunResultPayload | null = null;
  let findingsCount: number | null = null;
  let judgeNote: string | undefined;

  if (rr?.status === 'completed') {
    const judged = judgeRunParts(judgeSetup, rr.usage, rr.judge, review.judgeSemantic);
    judgeNote = judged.note;
    payload = {
      ...prepareRunResult({
        summary: rr.summary,
        inlineFindings: rr.inline,
        summaryOnlyFindings: rr.summaryOnly,
        language: ctx.settings.language,
        usage: judged.usage,
        verification: rr.verification,
        judge: judged.judge,
        knownSecrets,
      }),
      ...disclosed(),
    };
    findingsCount = rr.inline.length + rr.summaryOnly.length;
  } else if (rr?.status === 'failed') {
    // A failed run keeps what it spent and how (ADR-0027 amendment): no summary, no findings, and
    // none of the provider's text, which stays in the redacted `detail` and the logs.
    payload = {
      v: 1,
      summary: '',
      highlights: [],
      findings: [],
      language: ctx.settings.language,
      ...(rr.usage ? { usage: { inputTokens: rr.usage.inputTokens, outputTokens: rr.usage.outputTokens } } : {}),
      ...disclosed(),
    };
  } else if (status === 'skipped') {
    findingsCount = 0;
  }
  const detail = br.skipPaidFallbacks?.length
    ? [review.detail, skippedNote].filter(Boolean).join('; ') || judgeNote || null
    : review.detail ?? skippedNote ?? judgeNote ?? null;
  const used = usedModel(
    choice,
    { ...ctx.settings, fallback: br.bot.fallback },
    review.modelUsed,
    review.fallbackFrom,
    review.fallbackFromMethod,
    review.modelUsedMethod,
  );
  return {
    finish: {
      status,
      costUsd,
      detail,
      provider: used.provider,
      model: used.model,
      effort: used.effort,
      fallbackFrom: used.fallbackFrom,
      findingsCount,
      result: payload,
      reviewUrl: null,
    },
    result: { status, costUsd, detail, ...(review.outcome === 'skipped-budget' ? { skippedForBudget: true as const } : {}) },
    modelLabel: `${used.provider}:${used.model}`,
  };
}

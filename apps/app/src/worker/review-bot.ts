import { createReviewModel, redactSecrets, type ReviewModel, type Secret } from '@mergepilot/engine';
import type { SemanticDedupeResult } from '@mergepilot/github';
import {
  MAIN_BOT_SLOT,
  WorkspaceDeletedError,
  type ApiProvider,
  type FinishReviewRunOptions,
  type ReviewRunResultPayload,
  type ReviewRunStatus,
} from '../core/types.js';
import type { RunPricing } from '../core/price-types.js';
import { createSafeFetch, REVIEW_FETCH_LIMITS } from '../core/safe-fetch.js';
import { buildBotConfig } from './bot-config.js';
import { reviewOnlyOutcome, runBotReview, type BotFiles, type ReviewOnlyOutcome } from './bot-review-run.js';
import { executeReview } from './execute-review.js';
import { judgeRunParts, workspaceJudge, type WorkspaceJudge } from './judge-setup.js';
import { customBaseUrlFor, fallbackChain, skippedFallbacksNote, usedModel, type ModelChoice } from './model-choice.js';
import type { BotOutcome, BotRun, PanelContext } from './panel-types.js';
import { prepareRunResult } from './prepare-run-result.js';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';
import type { ProcessReviewResult } from './types.js';

export const WORKSPACE_DELETED = 'workspace_deleted';

/** The model a bot reviews with: slot 1 may use the heavy-duty model; extra bots never do. */
export function botChoice(ctx: PanelContext, br: BotRun): ModelChoice {
  if (br.bot.slot === 1) return ctx.mainChoice;
  return { provider: br.bot.provider, model: br.bot.model, effort: br.bot.effort, heavy: false };
}

/**
 * Runs ONE bot end to end (ADR-0017): config, credentials, model chain, the review and its run
 * record. In separate mode (or for a lone main bot) it publishes its own review and finishes its
 * run; with `consensus` it only reviews, and the panel publishes and finishes the run later.
 * Never throws: a failure is recorded on this bot's run only.
 */
export async function runBot(ctx: PanelContext, br: BotRun, consensus?: BotFiles): Promise<BotOutcome> {
  const { deps, job, workspaceId, settings, logger } = ctx;
  const slot = br.bot.slot;
  const choice = botChoice(ctx, br);
  let credStore: WorkspaceCredentialStore | undefined;
  try {
    const fallbackList = fallbackChain(br.bot.fallback, choice);
    const customBaseUrl = await customBaseUrlFor(
      deps.store,
      workspaceId,
      choice.provider,
      fallbackList.map((f) => f.provider),
      deps.ssrfLookup,
    );
    // Slot 1's config (and its price) was built once by the shared steps; an extra bot prices its own model.
    const { effectiveConfig, rulesFiles, configHash, pricing: configuredPricing } =
      slot === MAIN_BOT_SLOT
        ? ctx.mainConfig
        : await buildBotConfig(ctx.repoConfigResult, choice, fallbackList, settings, deps.store);

    const primarySecret = await deps.credentials.resolve(workspaceId, choice.provider as ApiProvider);
    credStore = new WorkspaceCredentialStore(workspaceId, deps.credentials, choice.provider as ApiProvider, primarySecret);
    const judgeSetup = await workspaceJudge(settings, workspaceId, deps.credentials, logger, {
      jobId: job.deliveryId,
      runId: br.run.id,
      fetch: deps.judgeFetch,
      priceLookup: ctx.judgePrices,
    });
    credStore.addKnownSecrets(judgeSetup.secrets);

    let model: ReviewModel;
    if (deps.createModelForProvider) {
      model = await deps.createModelForProvider(effectiveConfig, primarySecret);
    } else {
      model = await createReviewModel(effectiveConfig, credStore, {
        cwd: process.cwd(),
        ...(customBaseUrl
          ? { customBaseUrl, customFetch: deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup, ...REVIEW_FETCH_LIMITS }) }
          : {}),
      });
    }
    const pricing: RunPricing = model.includedInSubscription
      ? { source: 'static', inputPerMTok: 0, outputPerMTok: 0 }
      : configuredPricing;
    // A configured fallback left out (no key, or a custom URL that failed the SSRF check) is
    // disclosed in the log and on the run record; it is never called.
    const skippedNote = skippedFallbacksNote(model);
    if (skippedNote) deps.log?.(skippedNote);

    const knownSecrets = credStore.getKnownSecrets();
    const params = {
      client: ctx.client,
      owner: ctx.owner,
      repo: ctx.repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      baseSha: job.baseSha,
      prTitle: ctx.prTitle,
      prBody: ctx.prBody,
      config: effectiveConfig,
      configHash,
      rulesFiles,
      model,
      knownSecrets,
      publisherLogin: ctx.publisherLogin,
      ...(deps.log ? { log: deps.log } : {}),
      judge: judgeSetup.judge,
      ...(ctx.panelActive ? { botSlot: slot, prFiles: ctx.prFiles } : {}),
    };

    if (consensus) {
      const outcome = reviewOnlyOutcome(
        await runBotReview({ ...params, prFiles: consensus.prFiles, selection: consensus.selection }),
        { knownSecrets, judge: judgeSetup.judge },
      );
      const record = recordOf(ctx, br, choice, outcome, judgeSetup, credStore.getKnownSecrets(), skippedNote, pricing);
      if (outcome.fallback) {
        const { from, code, detail: why } = outcome.fallback;
        deps.log?.(`Fallback used: ${from} failed (${code})${why ? `: ${why}` : ''}`);
      }
      return { slot, result: record.result, pending: { ...record, outcome, knownSecrets: credStore.getKnownSecrets() } };
    }

    const reviewResult = await executeReview({
      ...params,
      ...(ctx.panelActive
        ? {
            identity: {
              name: br.bot.name,
              logo: br.bot.logo,
              modelLabel: `${choice.provider}:${choice.model}`,
              baseUrl: ctx.baseUrl,
            },
          }
        : {}),
    });
    const record = recordOf(ctx, br, choice, reviewResult, judgeSetup, credStore.getKnownSecrets(), skippedNote, pricing);
    record.finish.reviewUrl = reviewResult.reviewUrl ?? null;
    await finishBotRun(ctx, br, record.finish, reviewResult.runResult);
    return { slot, result: record.result, findings: record.finish.findingsCount ?? 0 };
  } catch (error) {
    return { slot, result: await failBotRun(ctx, br, error, credStore?.getKnownSecrets() ?? [], choice) };
  }
}

interface BotRecord {
  finish: FinishReviewRunOptions;
  result: ProcessReviewResult;
  modelLabel: string;
}

/** The run record of a reviewed bot: status, cost, detail, the model that answered, findings. */
function recordOf(
  ctx: PanelContext,
  br: BotRun,
  choice: ModelChoice,
  review: ReviewOnlyOutcome & { judgeSemantic?: SemanticDedupeResult | undefined },
  judgeSetup: WorkspaceJudge,
  knownSecrets: Secret[],
  skippedNote: string | undefined,
  pricing: RunPricing,
): BotRecord {
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

  if (review.runResult && review.runResult.status === 'completed') {
    const rr = review.runResult;
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
      // What priced this bot's own model (ADR-0016).
      pricing,
    };
    findingsCount = rr.inline.length + rr.summaryOnly.length;
  } else if (status === 'skipped') {
    findingsCount = 0;
  }
  const detail = review.detail ?? skippedNote ?? judgeNote ?? null;
  const used = usedModel(choice, { ...ctx.settings, fallback: br.bot.fallback }, review.modelUsed, review.fallbackFrom);
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
    result: { status, costUsd, detail },
    modelLabel: `${used.provider}:${used.model}`,
  };
}

/** Records a reviewed bot's run and logs `job.end` (with the bot slot when the panel is active). */
export async function finishBotRun(
  ctx: PanelContext,
  br: BotRun,
  finish: FinishReviewRunOptions,
  runResult: ReviewOnlyOutcome['runResult'],
): Promise<void> {
  await ctx.deps.store.finishReviewRun(ctx.workspaceId, br.run.id, finish);
  br.stopHeartbeat();
  const usage = runResult?.status === 'completed' ? runResult.usage : undefined;
  ctx.logger.info({
    event: 'job.end', jobId: ctx.job.deliveryId, runId: br.run.id, status: finish.status,
    ...(ctx.panelActive ? { botSlot: br.bot.slot } : {}),
    provider: finish.provider, model: finish.model, fallbackFrom: finish.fallbackFrom ?? null,
    findingsCount: finish.findingsCount ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    cost: finish.costUsd, durationMs: Math.round(performance.now() - ctx.startTime), reviewUrl: finish.reviewUrl ?? null,
  }, `Review job ${ctx.job.deliveryId} finished with status ${finish.status}`);
  if (runResult?.status === 'failed' && runResult.answerAttempts) {
    // What the model said instead of the JSON: logs only, never the dashboard or the PR.
    ctx.logger.warn({
      event: 'review.unusable-answer', jobId: ctx.job.deliveryId, runId: br.run.id,
      ...(ctx.panelActive ? { botSlot: br.bot.slot } : {}),
      provider: finish.provider, model: finish.model, attempts: runResult.answerAttempts,
    }, `Review job ${ctx.job.deliveryId}: the model answered without the JSON asked for`);
  }
}

/**
 * Records a bot's run as failed (or skipped when the workspace was deleted), with a redacted
 * detail, and returns the result the job would report for it.
 */
export async function failBotRun(
  ctx: Pick<PanelContext, 'deps' | 'logger' | 'job' | 'workspaceId'>,
  br: BotRun,
  error: unknown,
  knownSecrets: Secret[],
  choice: Pick<ModelChoice, 'provider' | 'model' | 'effort'>,
): Promise<ProcessReviewResult> {
  const { deps, logger, job, workspaceId } = ctx;
  try {
    if (error instanceof WorkspaceDeletedError) {
      const message = `Review job ${job.deliveryId} skipped: workspace ${workspaceId} was deleted`;
      deps.log?.(message);
      logger.info({ event: 'job.skipped', jobId: job.deliveryId, reason: WORKSPACE_DELETED, workspaceId }, message);
      await deps.store.finishReviewRun(workspaceId, br.run.id, { status: 'skipped', costUsd: null, detail: WORKSPACE_DELETED });
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const redactedDetail = redactSecrets(rawMessage, knownSecrets).text.slice(0, 500);
    const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    const failureCode = typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN_ERROR';

    deps.log?.(`Review job ${job.deliveryId} failed: ${redactedDetail}`);
    logger.error({
      event: 'job.failed', jobId: job.deliveryId, runId: br.run.id,
      workspace: workspaceId, failureCode, message: redactedDetail,
    }, `Review job ${job.deliveryId} failed: ${redactedDetail}`);

    await deps.store.finishReviewRun(workspaceId, br.run.id, {
      status: 'failed',
      costUsd: null,
      detail: redactedDetail,
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
    });
    return { status: 'failed', detail: redactedDetail };
  } finally {
    br.stopHeartbeat();
  }
}

import { createReviewModel, redactSecrets, type ApiProviderId, type ReviewModel, type Secret, type TokenUsage } from '@mergepilot/engine';
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
import { skillKeyOf } from './effective-config.js';
import { reviewOnlyOutcome, runBotReview, type BotFiles, type ReviewOnlyOutcome } from './bot-review-run.js';
import { executeReview } from './execute-review.js';
import { judgeRunParts, workspaceJudge, type WorkspaceJudge } from './judge-setup.js';
import { customBaseUrlFor, fallbackChain, skippedFallbacksNote, usedModel, type ModelChoice } from './model-choice.js';
import type { BotOutcome, BotRun, PanelContext } from './panel-types.js';
import { CursorWrites, loadRosters, rosterSecrets, rotationHandler, type KeyRotationDisclosure } from './key-roster.js';
import { prepareRunResult } from './prepare-run-result.js';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';
import type { ProcessReviewResult } from './types.js';
import { apiEquivalentFields, apiEquivalentPrice, type ApiEquivalentPrice } from './api-equivalent.js';
import { admittedSubscription, apiPricedConfig, dualMethodsForProviders, withinAdmission } from './dual-method-review.js';

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
  const cursorWrites = new CursorWrites();
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
    const builtConfig =
      slot === MAIN_BOT_SLOT
        ? ctx.mainConfig
        : await buildBotConfig(ctx.repoConfigResult, choice, fallbackList, settings, deps.store, skillKeyOf([br.bot]));
    const providerIds = [choice.provider, ...fallbackList.map((fallback) => fallback.provider)];
    // Admitted free, the bot keeps that decision for its whole run (ADR-0033): its provider runs on
    // the subscription it was admitted with, whatever the default method is now.
    const subscriptionOnly = br.admittedFree === true;
    const dualMethods = withinAdmission(
      await dualMethodsForProviders(deps.credentials, workspaceId, providerIds, logger),
      br.admittedFree,
      choice.provider,
    );
    const { effectiveConfig, rulesFiles, configHash, pricing: configuredPricing } = dualMethods[choice.provider as ApiProviderId]
      ? await apiPricedConfig(builtConfig, deps.store, settings, choice)
      : builtConfig;

    const effectiveAuth = await deps.credentials.getEffectiveAuthMethod?.(workspaceId, choice.provider as ApiProvider);
    let primarySecret: Secret;
    if (subscriptionOnly) {
      primarySecret = await admittedSubscription(deps.credentials, workspaceId, choice.provider);
    } else if (effectiveAuth === 'api-key' && deps.credentials.resolveKeyRoster) {
      const roster = await deps.credentials.resolveKeyRoster(workspaceId, choice.provider as ApiProvider);
      if (!roster || roster.secrets.length === 0) {
        throw new Error(`No API key roster is available for provider "${choice.provider}"`);
      }
      const start = roster.startIndex >= 0 && roster.startIndex < roster.secrets.length ? roster.startIndex : 0;
      primarySecret = roster.secrets[start]!;
    } else {
      primarySecret = await deps.credentials.resolve(workspaceId, choice.provider as ApiProvider);
    }
    credStore = new WorkspaceCredentialStore(workspaceId, deps.credentials, choice.provider as ApiProvider, primarySecret, { subscriptionOnly });
    const rotationEvents: KeyRotationDisclosure[] = [];
    const makeRotationHandler = (keyIds: Readonly<Record<string, readonly string[]>>) =>
      rotationHandler(rotationEvents, deps.credentials, workspaceId, logger, keyIds, cursorWrites);
    const judgeSetup = await workspaceJudge(settings, workspaceId, deps.credentials, logger, {
      jobId: job.deliveryId,
      runId: br.run.id,
      fetch: deps.judgeFetch,
      priceLookup: ctx.judgePrices,
      makeRotationHandler,
    });
    credStore.addKnownSecrets(judgeSetup.secrets);

    let model: ReviewModel;
    if (deps.createModelForProvider) {
      model = await deps.createModelForProvider(effectiveConfig, primarySecret);
    } else {
      // No key roster for a subscription-only provider: the engine would rotate over paid keys.
      const rosterProviders = subscriptionOnly ? providerIds.filter((provider) => provider !== choice.provider) : providerIds;
      const { rosters, keyIds } = await loadRosters(deps.credentials, workspaceId, rosterProviders, choice.provider, logger, dualMethods);
      credStore.addKnownSecrets(rosterSecrets(rosters));
      model = await createReviewModel(effectiveConfig, credStore, {
        cwd: process.cwd(),
        keyRosters: rosters,
        onKeyRotation: makeRotationHandler(keyIds),
        dualMethods,
        ...(customBaseUrl
          ? { customBaseUrl, customFetch: deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup, ...REVIEW_FETCH_LIMITS }) }
          : {}),
      });
    }
    const apiPrice = await apiEquivalentPrice(deps.store, settings, model, choice, configuredPricing).catch((error: unknown) => {
      // Display only: a price lookup that fails leaves the run without an equivalent, never failed.
      logger.warn(
        { event: 'review.api_equivalent_failed', jobId: job.deliveryId, runId: br.run.id, error: error instanceof Error ? error.name : 'unknown' },
        'Could not price the API-equivalent; the run shows none',
      );
      return undefined;
    });
    // A configured fallback left out (no key, or a custom URL that failed the SSRF check) is
    // disclosed in the log and on the run record; it is never called.
    const recordPricing: RecordPricing = {
      pricing: configuredPricing,
      apiPrice,
      rotation: rotationEvents,
      onSubscription: model.includedInSubscription === true,
    };
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
      ...(job.force ? { force: true } : {}),
      ...(br.bot.skill ? { skill: { name: br.bot.skill.name, content: br.bot.skill.content } } : {}),
    };

    if (consensus) {
      const outcome = reviewOnlyOutcome(
        await runBotReview({ ...params, prFiles: consensus.prFiles, selection: consensus.selection }),
        { knownSecrets, judge: judgeSetup.judge },
      );
      await cursorWrites.flush();
      const record = recordOf(ctx, br, choice, outcome, judgeSetup, credStore.getKnownSecrets(), skippedNote, recordPricing);
      if (outcome.fallback) {
        const { from, code, detail: why } = outcome.fallback;
        deps.log?.(`Fallback used: ${from} failed (${code})${why ? `: ${why}` : ''}`);
      }
      return { slot, result: record.result, pending: { ...record, outcome, knownSecrets: credStore.getKnownSecrets() } };
    }

    const reviewResult = await executeReview({
      ...params,
      // A lone bot shows its identity line only to name its skill (ADR-0034).
      ...(ctx.panelActive || br.bot.skill
        ? {
            identity: {
              name: br.bot.name,
              logo: br.bot.logo,
              modelLabel: `${choice.provider}:${choice.model}`,
              baseUrl: ctx.baseUrl,
              ...(br.bot.skill ? { skill: br.bot.skill.name } : {}),
            },
          }
        : {}),
    });
    await cursorWrites.flush();
    const record = recordOf(ctx, br, choice, reviewResult, judgeSetup, credStore.getKnownSecrets(), skippedNote, recordPricing);
    record.finish.reviewUrl = reviewResult.reviewUrl ?? null;
    await finishBotRun(ctx, br, record.finish, reviewResult.runResult);
    return { slot, result: record.result, findings: record.finish.findingsCount ?? 0 };
  } catch (error) {
    await cursorWrites.flush();
    return { slot, result: await failBotRun(ctx, br, error, credStore?.getKnownSecrets() ?? [], choice) };
  }
}

interface RecordPricing {
  /** What priced the bot's own model (ADR-0016). */
  pricing: RunPricing;
  /** The display-only API price of a subscription or token-plan model (ADR-0024). */
  apiPrice: ApiEquivalentPrice | undefined;
  rotation: readonly KeyRotationDisclosure[];
  /** The primary model runs on a consumer subscription. */
  onSubscription: boolean;
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
  { pricing, apiPrice, rotation, onSubscription }: RecordPricing,
): BotRecord {
  // `subscription` ($0) only while every call stayed on a subscription; a run that switched to
  // paid API keys is priced at the API price (ADR-0027). A run that made no model call has no
  // tally, and without a fallback all its calls were on the primary.
  const rr = review.runResult;
  const allOnSubscription =
    rr && rr.status !== 'skipped-budget' ? rr.onlySubscriptionCalls : onSubscription && !review.fallbackFrom;
  const runPricing: RunPricing = allOnSubscription ? { source: 'subscription', inputPerMTok: 0, outputPerMTok: 0 } : pricing;
  // What priced this bot's own model (ADR-0016), plus the display-only API-equivalent of a
  // subscription or token-plan run (ADR-0024), from its own usage before the judge's tokens; the
  // method switch (ADR-0027) and the key rotation (ADR-0026). Never a secret or provider text.
  const disclosed = (usage: TokenUsage | undefined): Pick<ReviewRunResultPayload, 'pricing' | 'fallbackFromMethod' | 'modelUsedMethod' | 'keyRotation'> => ({
    pricing: { ...runPricing, ...apiEquivalentFields(usage, review.fallbackFrom ? undefined : apiPrice) },
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
      ...disclosed(rr.usage),
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
      ...disclosed(rr.usage),
    };
  } else if (status === 'skipped') {
    findingsCount = 0;
  }
  const detail = review.detail ?? skippedNote ?? judgeNote ?? null;
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

/** Records a reviewed bot's run and logs `job.end` (with the bot slot when the panel is active). */
export async function finishBotRun(
  ctx: PanelContext,
  br: BotRun,
  finish: FinishReviewRunOptions,
  runResult: ReviewOnlyOutcome['runResult'],
): Promise<void> {
  await ctx.deps.store.finishReviewRun(ctx.workspaceId, br.run.id, finish);
  br.stopHeartbeat();
  const usage = runResult && runResult.status !== 'skipped-budget' ? runResult.usage : undefined;
  ctx.logger.info({
    event: 'job.end', jobId: ctx.job.deliveryId, runId: br.run.id, status: finish.status,
    ...(ctx.panelActive ? { botSlot: br.bot.slot } : {}),
    provider: finish.provider, model: finish.model, fallbackFrom: finish.fallbackFrom ?? null,
    // A method fallback (ADR-0027), on failed runs too: the two methods and the failure kind, never a secret.
    ...(runResult && runResult.status !== 'skipped-budget' && runResult.fallbackFromMethod
      ? { fallbackFromMethod: runResult.fallbackFromMethod, modelUsedMethod: runResult.modelUsedMethod, fallbackCode: runResult.fallbackCode }
      : {}),
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

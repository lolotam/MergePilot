import { createReviewModel, redactSecrets, type MergePilotConfig, type ReviewModel } from '@mergepilot/engine';
import { loadRepoConfig, publishReview, renderReviewSummary } from '@mergepilot/github';
import {
  ActiveRunExistsError,
  WorkspaceDeletedError,
  type ApiProvider,
  type ReviewJob,
  type ReviewRun,
  type ReviewRunResultPayload,
  type ReviewRunStatus,
} from '../core/types.js';
import { workerLogger } from '../core/logger.js';
import { createSafeFetch, REVIEW_FETCH_LIMITS } from '../core/safe-fetch.js';
import { judgePriceLookup, resolvePricing } from '../core/model-pricing.js';
import { effectiveConfigFor } from './effective-config.js';
import { executeReview } from './execute-review.js';
import { judgeRunParts, workspaceJudge } from './judge-setup.js';
import { pausedWithNotice, PAUSED_DETAIL } from './pause-check.js';
import { changedLinesOf, chooseModel, fallbackChain, skippedFallbacksNote, customBaseUrlFor, usedModel, type ModelChoice } from './model-choice.js';
import { prepareRunResult } from './prepare-run-result.js';
import { startRunHeartbeat } from './run-heartbeat.js';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';
import { guardWritesForWorkspace } from './workspace-guard.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

const WORKSPACE_DELETED = 'workspace_deleted';
const DUPLICATE = 'duplicate';

export async function processReviewJob(
  job: ReviewJob,
  deps: ProcessReviewDeps,
): Promise<ProcessReviewResult> {
  const logger = deps.logger ?? workerLogger;
  const startTime = performance.now();
  const logSkip = (reason: string, message: string, fields: Record<string, unknown> = {}): void => {
    deps.log?.(message);
    logger.info({ event: 'job.skipped', jobId: job.deliveryId, reason, ...fields }, message);
  };

  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    const detail = !installation ? 'unknown installation' : 'suspended installation';
    logSkip(detail, `Skipping job ${job.deliveryId}: installation ${job.installationId} is ${detail}`, { installationId: job.installationId });
    return { status: 'skipped', detail };
  }

  const workspaceId = installation.workspaceId;
  const settings = await deps.store.getSettings(workspaceId);
  if (!settings) {
    let run: ReviewRun;
    try {
      run = await deps.store.createReviewRun({
        workspaceId,
        jobId: job.deliveryId,
        installationId: job.installationId,
        repoFullName: job.repoFullName,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        status: 'running',
        costUsd: null,
        detail: null,
      });
    } catch (error) {
      if (error instanceof ActiveRunExistsError) {
        logSkip(DUPLICATE, `Skipping job ${job.deliveryId}: a run for this head is already active`);
        return { status: 'skipped', detail: DUPLICATE };
      }
      if (!(error instanceof WorkspaceDeletedError)) throw error;
      logSkip(WORKSPACE_DELETED, `Skipping job ${job.deliveryId}: workspace ${workspaceId} was deleted`, { workspaceId });
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    await deps.store.finishReviewRun(workspaceId, run.id, {
      status: 'skipped',
      costUsd: null,
      detail: 'workspace not configured',
    });
    logSkip('workspace not configured', `Skipping job ${job.deliveryId}: workspace ${workspaceId} not configured`, { runId: run.id, workspaceId });
    return { status: 'skipped', detail: 'workspace not configured' };
  }

  let run: ReviewRun | undefined;
  let credStore: WorkspaceCredentialStore | undefined;
  let stopHeartbeat: (() => void) | undefined;
  // The workspace model until the PR size is known; then possibly the heavy-duty model.
  let choice: ModelChoice = chooseModel(settings, 0);

  try {
    run = await deps.store.createReviewRun({
      workspaceId,
      jobId: job.deliveryId,
      installationId: job.installationId,
      repoFullName: job.repoFullName,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      status: 'running',
      costUsd: null,
      detail: null,
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
    });
    stopHeartbeat = startRunHeartbeat(deps.store, workspaceId, run.id, {
      intervalMs: deps.heartbeatIntervalMs,
      log: deps.log,
      logger,
    });
    logger.info({
      event: 'job.start', jobId: job.deliveryId, runId: run.id, workspace: workspaceId,
      repo: job.repoFullName, pullNumber: job.pullNumber, headSha: job.headSha.slice(0, 7),
    }, `Review job ${job.deliveryId} started for ${job.repoFullName}#${job.pullNumber}`);

    const [owner, repo] = job.repoFullName.split('/');
    if (!owner || !repo) throw new Error(`Invalid repoFullName: ${job.repoFullName}`);

    const { client: rawClient, publisherLogin } = await deps.githubAppFactory(job.installationId);
    const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, workspaceId);

    const pr = await client.getPullRequest({ owner, repo, pull_number: job.pullNumber });
    const pauseParams = { owner, repo, pullNumber: job.pullNumber, publisherLogin, labels: pr.labels, language: settings.language };
    if (await pausedWithNotice(client, pauseParams)) {
      await deps.store.finishReviewRun(workspaceId, run.id, { status: 'skipped', costUsd: null, detail: PAUSED_DETAIL });
      logSkip('paused', `Skipping job ${job.deliveryId}: ${PAUSED_DETAIL}`, { runId: run.id });
      return { status: 'skipped', detail: PAUSED_DETAIL };
    }
    const prRecord = pr as unknown as { title?: string; body?: string | null; additions?: number; deletions?: number };
    const prTitle = typeof prRecord.title === 'string' ? prRecord.title : '';
    const prBody = typeof prRecord.body === 'string' ? prRecord.body : '';

    // Only needed when a heavy model is set: no extra GitHub call otherwise.
    const changedLines = settings.heavyModel
      ? await changedLinesOf(client, { owner, repo, pull_number: job.pullNumber }, prRecord)
      : 0;
    choice = chooseModel(settings, changedLines);
    if (choice.heavy) deps.log?.(`Large PR (${changedLines} changed lines): using the heavy-duty model`);
    const { provider: chosenProvider, model: chosenModel, effort: chosenEffort } = choice;

    const repoConfigResult = await loadRepoConfig(client, { owner, repo, baseSha: job.baseSha });

    // Fallback entries never carry a URL: a `custom` entry uses the workspace's one custom
    // server URL, passed to the engine as the trusted `customBaseUrl` (ADR-0008 amendment).
    const fallbackList = fallbackChain(settings.fallback ?? [], choice);
    const customBaseUrl = await customBaseUrlFor(
      deps.store,
      workspaceId,
      chosenProvider,
      fallbackList.map((f) => f.provider),
      deps.ssrfLookup,
    );

    const built = effectiveConfigFor(repoConfigResult, choice, fallbackList, settings);
    const { rulesFiles, configHash } = built;
    // The primary model's price (ADR-0016): workspace override, repo file, catalog, else unknown.
    const pricing = await resolvePricing({ store: deps.store, settings, repoPricing: built.repoPricing }, chosenProvider, chosenModel);
    const effectiveConfig: MergePilotConfig = { ...built.config, budget: { ...built.config.budget, pricing: pricing.pricing } };

    if (settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined) {
      const now = deps.now ? deps.now() : new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      const currentMonthCost = await deps.store.monthCostUsd(workspaceId, monthStart);

      if (currentMonthCost >= settings.monthlyBudgetUsd) {
        const summaryMarkdown = renderReviewSummary({
          language: effectiveConfig.language, summary: '', summaryOnly: [], inlineCount: 0, complete: false,
          incompleteReasons: ['monthly budget reached'], modelLabel: effectiveConfig.model ?? effectiveConfig.provider,
          outcome: 'skipped-budget', reason: 'monthly budget reached',
        });

        const publishResult = await publishReview(client, {
          owner,
          repo,
          pull_number: job.pullNumber,
          expectedHeadSha: job.headSha,
          summaryMarkdown,
          inline: [],
          configHash,
          language: effectiveConfig.language,
          suggestionsAsCode: false,
          publisherLogin,
        });

        const budgetReviewUrl =
          'reviewId' in publishResult && typeof publishResult.reviewId === 'number'
            ? `https://github.com/${owner}/${repo}/pull/${job.pullNumber}#pullrequestreview-${publishResult.reviewId}`
            : null;

        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: 'monthly budget reached',
          provider: chosenProvider,
          model: chosenModel,
          effort: chosenEffort,
          fallbackFrom: null,
          findingsCount: 0,
          result: null,
          reviewUrl: budgetReviewUrl,
        });
        logSkip('monthly budget reached', `Monthly budget reached for workspace ${workspaceId}; skipping`, { runId: run.id, workspaceId });
        return { status: 'skipped', detail: 'monthly budget reached' };
      }
    }

    const primarySecret = await deps.credentials.resolve(workspaceId, chosenProvider as ApiProvider);
    credStore = new WorkspaceCredentialStore(workspaceId, deps.credentials, chosenProvider as ApiProvider, primarySecret);
    const judgeSetup = await workspaceJudge(settings, workspaceId, deps.credentials, logger, {
      jobId: job.deliveryId,
      runId: run.id,
      fetch: deps.judgeFetch,
      priceLookup: await judgePriceLookup(deps.store, settings),
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
    // A configured fallback left out (no key, or a custom URL that failed the SSRF check) is
    // disclosed in the log and on the run record; it is never called.
    const skippedNote = skippedFallbacksNote(model);
    if (skippedNote) deps.log?.(skippedNote);

    const reviewResult = await executeReview({
      client,
      owner,
      repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      baseSha: job.baseSha,
      prTitle,
      prBody,
      config: effectiveConfig,
      configHash,
      rulesFiles,
      model,
      knownSecrets: credStore.getKnownSecrets(),
      publisherLogin,
      ...(deps.log ? { log: deps.log } : {}),
      judge: judgeSetup.judge,
    });

    const status: ReviewRunStatus =
      reviewResult.outcome === 'completed'
        ? 'completed'
        : reviewResult.outcome === 'skipped-budget' || reviewResult.outcome === 'skipped'
          ? 'skipped'
          : 'failed';

    const costUsd = reviewResult.costUsd ?? null;
    let payload: ReviewRunResultPayload | null = null;
    let findingsCount: number | null = null;
    let judgeNote: string | undefined;

    if (reviewResult.runResult && reviewResult.runResult.status === 'completed') {
      const rr = reviewResult.runResult;
      const judged = judgeRunParts(judgeSetup, rr.usage, rr.judge, reviewResult.judgeSemantic);
      judgeNote = judged.note;
      payload = {
        ...prepareRunResult({
          summary: rr.summary,
          inlineFindings: rr.inline,
          summaryOnlyFindings: rr.summaryOnly,
          language: effectiveConfig.language,
          usage: judged.usage,
          verification: rr.verification,
          judge: judged.judge,
          knownSecrets: credStore.getKnownSecrets(),
        }),
        pricing: pricing.record,
      };
      findingsCount = rr.inline.length + rr.summaryOnly.length;
    } else if (status === 'skipped') {
      findingsCount = 0;
    }
    const detail = reviewResult.detail ?? skippedNote ?? judgeNote ?? null;

    const used = usedModel(choice, settings, reviewResult.modelUsed, reviewResult.fallbackFrom);
    await deps.store.finishReviewRun(workspaceId, run.id, {
      status,
      costUsd,
      detail,
      provider: used.provider,
      model: used.model,
      effort: used.effort,
      fallbackFrom: used.fallbackFrom,
      findingsCount,
      result: payload,
      reviewUrl: reviewResult.reviewUrl ?? null,
    });

    const usage = reviewResult.runResult?.status === 'completed' ? reviewResult.runResult.usage : undefined;
    logger.info({
      event: 'job.end', jobId: job.deliveryId, runId: run.id, status,
      provider: used.provider, model: used.model, fallbackFrom: used.fallbackFrom ?? null,
      findingsCount: findingsCount ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      cost: costUsd, durationMs: Math.round(performance.now() - startTime), reviewUrl: reviewResult.reviewUrl ?? null,
    }, `Review job ${job.deliveryId} finished with status ${status}`);
    return { status, costUsd, detail };
  } catch (error) {
    if (error instanceof ActiveRunExistsError && !run) {
      logSkip(DUPLICATE, `Skipping job ${job.deliveryId}: a run for this head is already active`);
      return { status: 'skipped', detail: DUPLICATE };
    }
    if (error instanceof WorkspaceDeletedError) {
      logSkip(WORKSPACE_DELETED, `Review job ${job.deliveryId} skipped: workspace ${workspaceId} was deleted`, { workspaceId });
      if (run) {
        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: WORKSPACE_DELETED,
        });
      }
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const known = credStore?.getKnownSecrets() ?? [];
    const redactedDetail = redactSecrets(rawMessage, known).text.slice(0, 500);

    const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    const failureCode = typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN_ERROR';

    deps.log?.(`Review job ${job.deliveryId} failed: ${redactedDetail}`);
    logger.error({
      event: 'job.failed', jobId: job.deliveryId, runId: run?.id ?? null,
      workspace: workspaceId, failureCode, message: redactedDetail,
    }, `Review job ${job.deliveryId} failed: ${redactedDetail}`);

    if (run) {
      await deps.store.finishReviewRun(workspaceId, run.id, {
        status: 'failed',
        costUsd: null,
        detail: redactedDetail,
        provider: choice.provider,
        model: choice.model,
        effort: choice.effort,
      });
    }

    return { status: 'failed', detail: redactedDetail };
  } finally {
    stopHeartbeat?.();
  }
}

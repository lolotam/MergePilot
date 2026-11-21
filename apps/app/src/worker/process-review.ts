import { reviewCorrelation } from '../core/review-correlation.js';
import { processBudgetAdmission } from './budget-admission.js';
import {
  listPullRequestFiles,
  loadRepoConfig,
  publishReview,
  rebuildMissingPatches,
  renderReviewSummary,
} from '@mergepilot/github';
import {
  DEFAULT_PANEL_MODE,
  MAIN_BOT_SLOT,
  WorkspaceDeletedError,
  ActiveRunExistsError,
  type ReviewJob,
  type ReviewRun,
} from '../core/types.js';
import { workerLogger } from '../core/logger.js';
import { judgePriceLookup } from '../core/model-pricing.js';
import { buildBotConfig } from './bot-config.js';
import { pausedWithNotice, PAUSED_DETAIL } from './pause-check.js';
import { changedLinesOf, chooseModel, fallbackChain } from './model-choice.js';
import { noteBudgetSkipped } from './budget-skip-note.js';
import { notePanelFailed } from './panel-failed-note.js';
import { noteNothingNew } from './nothing-new-note.js';
import { panelTimeoutKeyOf } from './panel-timeout-key.js';
import { closeRuns, loadBotSkills, NO_KEY_DETAIL, panelBots, runPanel, startBotRuns, type StartedRuns } from './panel.js';
import { skillKeyOf } from './effective-config.js';
import type { BotRun, PanelContext } from './panel-types.js';
import { reviewUsesSubscriptionAdmission } from './dual-method-review.js';
import { failBotRun, WORKSPACE_DELETED } from './review-bot.js';
import { guardWritesForWorkspace } from './workspace-guard.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

/** Run detail when another job already holds an active run for this head (and bot). */
export const DUPLICATE = 'duplicate';
const BUDGET_REACHED = 'monthly budget reached';
const BOTS_OFF = 'bots are off';
const ALL_BOTS_OFF = 'all bots are off';

/**
 * One review job per PR head. The shared steps run once (installation, settings, run rows, PR,
 * pause, repo config, monthly budget); then every active bot of the reviewer panel reviews in
 * parallel (ADR-0017). The job reports the main bot's result when it is active, otherwise the first
 * running bot's. Migration 0021: a master-off or all-off workspace skips before any run or PR write.
 */
export async function processReviewJob(
  job: ReviewJob,
  deps: ProcessReviewDeps,
): Promise<ProcessReviewResult> {
  const logger = deps.logger ?? workerLogger;
  const startTime = performance.now();
  const logSkip = (reason: string, message: string, fields: Record<string, unknown> = {}): void => {
    deps.log?.(message);
    logger.info({ event: 'job.skipped', ...reviewCorrelation(job), reason, ...fields }, message);
  };

  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    const detail = !installation ? 'unknown installation' : 'suspended installation';
    logSkip(detail, `Skipping job ${job.deliveryId}: installation ${job.installationId} is ${detail}`, { installationId: job.installationId });
    return { status: 'skipped', detail };
  }

  const workspaceId = installation.workspaceId;
  const settings = await deps.store.getSettings(workspaceId);
  // The master switch is checked before any run, PR write or comment: even an explicit
  // `@mergepilot review` cannot turn bots back on (migration 0021). The per-bot switches stay saved.
  if (settings?.botsEnabled === false) {
    logSkip('bots-off', `Skipping job ${job.deliveryId}: ${BOTS_OFF}`, { workspaceId });
    return { status: 'skipped', detail: BOTS_OFF };
  }
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
    logSkip('workspace not configured', `Skipping job ${job.deliveryId}: workspace ${workspaceId} not configured`, { runId: run.id, botSlot: MAIN_BOT_SLOT, workspaceId });
    return { status: 'skipped', detail: 'workspace not configured' };
  }

  const extras = await deps.store.listReviewerBots(workspaceId);
  const skills = await loadBotSkills(deps.store, workspaceId, [settings.skillId, ...extras.filter((b) => b.active).map((b) => b.skillId)]);
  const bots = panelBots(settings, extras, skills);
  // Nothing to review: both the main bot and every extra are off. No run row and no PR write.
  if (bots.length === 0) {
    logSkip('all-bots-off', `Skipping job ${job.deliveryId}: ${ALL_BOTS_OFF}`, { workspaceId });
    return { status: 'skipped', detail: ALL_BOTS_OFF };
  }
  const panelActive = bots.length > 1;
  // With main off, the lowest active extra that has a key is the fixed publication identity for
  // this job, even when it fails and another completes (migration 0021). It must be a bot that can
  // run: its run row is the lease that keeps two concurrent jobs from both publishing.
  let publisherSlot = MAIN_BOT_SLOT;
  if (settings.mainBotActive === false) {
    publisherSlot = bots[0]!.slot;
    for (const bot of bots) {
      if (await deps.store.getCredential(workspaceId, bot.provider)) {
        publisherSlot = bot.slot;
        break;
      }
    }
  }
  const mode = settings.panelMode ?? DEFAULT_PANEL_MODE;
  const consensusMode = panelActive && mode === 'consensus';
  // The lead bot's marker hash holds its own skill; in consensus, where the panel selects files
  // once with that marker, the skills of every bot (ADR-0034) and every active bot's explicit
  // call timeout (`panelTimeoutKeyOf`) are part of it. With the main bot off, the lead is the first
  // active extra, so none of the shared steps depends on the main bot's configuration.
  const mainSkillKey = skillKeyOf(consensusMode ? bots : bots.slice(0, 1));
  const mainTimeoutKey = consensusMode ? panelTimeoutKeyOf(bots) : undefined;
  if (panelActive) {
    logger.info(
      { event: 'panel.start', ...reviewCorrelation(job), bots: bots.map((b) => b.slot), mode },
      `Reviewer panel of ${bots.length} bots started (${mode})`,
    );
  }

  const base = { job, deps, logger, workspaceId };
  let started: StartedRuns;
  try {
    started = await startBotRuns(base, bots);
  } catch (error) {
    if (!(error instanceof WorkspaceDeletedError)) throw error;
    logSkip(WORKSPACE_DELETED, `Review job ${job.deliveryId} skipped: workspace ${workspaceId} was deleted`, { workspaceId });
    return { status: 'skipped', detail: WORKSPACE_DELETED };
  }
  for (const slot of started.duplicates) {
    const bot = slot === MAIN_BOT_SLOT ? '' : ` (bot ${slot})`;
    logSkip(DUPLICATE, `Skipping job ${job.deliveryId}${bot}: a run for this head is already active`, { botSlot: slot });
  }
  const runs = started.running;
  if (runs.length === 0 && started.noKey.length > 0) {
    logSkip(NO_KEY_DETAIL, `Skipping job ${job.deliveryId}: ${NO_KEY_DETAIL}`, { workspaceId });
    return { status: 'skipped', detail: NO_KEY_DETAIL };
  }
  const publisher = runs.find((br) => br.bot.slot === publisherSlot);
  const duplicate: ProcessReviewResult = { status: 'skipped', detail: DUPLICATE };
  const lead = publisher ?? runs[0];
  if (!lead) return duplicate;
  const jobResult = (results: Map<number, ProcessReviewResult>): ProcessReviewResult =>
    results.get(publisherSlot) ?? results.get(lead.bot.slot) ?? duplicate;
  // Consensus publishes as the fixed publisher slot: without its run (another job holds it), this
  // job must not race that job's publication, so the other bots it started close as duplicates.
  if (!publisher && panelActive && mode === 'consensus') {
    for (const br of runs) {
      br.stopHeartbeat();
      await deps.store.finishReviewRun(workspaceId, br.run.id, { status: 'skipped', costUsd: null, detail: DUPLICATE });
    }
    logSkip(DUPLICATE, `Skipping job ${job.deliveryId}: the publisher's run for this head is active elsewhere (consensus)`);
    return duplicate;
  }

  let releaseBudget: (() => void) | undefined;
  try {
    logger.info({
      event: 'job.start', ...reviewCorrelation(job), runId: lead.run.id, workspace: workspaceId,
      repo: job.repoFullName, pullNumber: job.pullNumber, headSha: job.headSha, botSlot: lead.bot.slot,
    }, `Review job ${job.deliveryId} started for ${job.repoFullName}#${job.pullNumber}`);

    let ctx: PanelContext;
    try {
      const shared = await sharedSteps(
        { ...base, settings, publisherSlot }, runs, publisher, lead, logSkip, startTime, panelActive, mainSkillKey, mainTimeoutKey,
      );
      if ('result' in shared) return shared.result;
      releaseBudget = shared.releaseBudget;
      ctx = { ...shared.ctx, mode };
    } catch (error) {
      const failed = await Promise.all(
        runs.map((br) =>
          failBotRun(base, br, error, [], { provider: br.bot.provider, model: br.bot.model, effort: br.bot.effort }),
        ),
      );
      const bySlot = new Map(runs.map((br, index) => [br.bot.slot, failed[index]!]));
      return bySlot.get(publisherSlot) ?? bySlot.get(lead.bot.slot) ?? duplicate;
    }

    const results = await runPanel(ctx, runs, started.noKey);
    await noteNothingNew(ctx, results);
    await noteBudgetSkipped(ctx, results);
    await notePanelFailed(ctx, results);
    return jobResult(results);
  } finally {
    for (const br of runs) br.stopHeartbeat();
    releaseBudget?.();
  }
}

type SharedOutcome =
  | { result: ProcessReviewResult }
  | { ctx: Omit<PanelContext, 'mode'>; releaseBudget?: (() => void) | undefined };

/**
 * The steps every bot shares, run once: PR, pause, repository config, the main bot's model and
 * config, and the monthly budget (it covers all bots: when reached, every bot's run is skipped
 * and only the main bot publishes the notice, as before the panel). The main bot's config hash
 * takes its own call timeout override and, in consensus mode, the panel's timeouts
 * (`mainTimeoutKey`) alongside its skill key.
 */
async function sharedSteps(
  shared: Pick<PanelContext, 'job' | 'deps' | 'logger' | 'workspaceId' | 'settings' | 'publisherSlot'>,
  runs: BotRun[],
  publisher: BotRun | undefined,
  lead: BotRun,
  logSkip: (reason: string, message: string, fields?: Record<string, unknown>) => void,
  startTime: number,
  panelActive: boolean,
  mainSkillKey: string | undefined,
  mainTimeoutKey: string | undefined,
): Promise<SharedOutcome> {
  const { settings, publisherSlot, ...base } = shared;
  const { job, deps, logger, workspaceId } = base;
  let releaseBudget: (() => void) | undefined;
  const [owner, repo] = job.repoFullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFullName: ${job.repoFullName}`);

  const { client: rawClient, publisherLogin } = await deps.githubAppFactory(job.installationId);
  const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, workspaceId);

  const pr = await client.getPullRequest({ owner, repo, pull_number: job.pullNumber });
  const pauseParams = { owner, repo, pullNumber: job.pullNumber, publisherLogin, labels: pr.labels, language: settings.language };
  // Pause stops automatic reviews only: an explicit `@mergepilot review` still runs.
  if (!job.force && (await pausedWithNotice(client, pauseParams))) {
    await closeRuns(base, runs, PAUSED_DETAIL);
    logSkip('paused', `Skipping job ${job.deliveryId}: ${PAUSED_DETAIL}`, { runId: lead.run.id, botSlot: lead.bot.slot });
    return { result: { status: 'skipped', detail: PAUSED_DETAIL } };
  }
  const prRecord = pr as unknown as { title?: string; body?: string | null; additions?: number; deletions?: number };
  const prTitle = typeof prRecord.title === 'string' ? prRecord.title : '';
  const prBody = typeof prRecord.body === 'string' ? prRecord.body : '';

  // Only needed when the main bot runs with a heavy model: no extra GitHub call otherwise.
  const changedLines = settings.heavyModel && publisher && publisherSlot === MAIN_BOT_SLOT
    ? await changedLinesOf(client, { owner, repo, pull_number: job.pullNumber }, prRecord)
    : 0;
  // With main off the publisher's provider and model lead the shared config and marker; slot 1's
  // settings lead when main is active (migration 0021).
  const mainChoice = publisherSlot === MAIN_BOT_SLOT
    ? chooseModel(settings, changedLines)
    : { provider: lead.bot.provider, model: lead.bot.model, effort: lead.bot.effort ?? null, heavy: false };
  if (mainChoice.heavy) deps.log?.(`Large PR (${changedLines} changed lines): using the heavy-duty model`);

  // The dashboard picks every bot's provider and model, so the repo file may leave them out; the
  // workspace's findings limit applies unless the file names its own `review.maxFindings` (ADR-0033).
  const repoConfigResult = await loadRepoConfig(client, {
    owner,
    repo,
    baseSha: job.baseSha,
    defaults: { provider: mainChoice.provider, model: mainChoice.model, maxFindings: settings.maxFindings, perReviewUsd: settings.perReviewUsd },
  });
  // The lead bot's config, priced for its model (the heavy-duty one when the main bot chose it;
  // ADR-0016), with its own call timeout override and — in consensus mode — the panel's timeouts
  // in the marker identity. With the main bot off, the lead is an extra bot.
  const sharedFallback = publisherSlot === MAIN_BOT_SLOT ? settings.fallback ?? [] : lead.bot.fallback;
  const sharedCallTimeoutMs = publisherSlot === MAIN_BOT_SLOT ? settings.callTimeoutMs : lead.bot.callTimeoutMs;
  const mainConfig = await buildBotConfig(
    repoConfigResult,
    mainChoice,
    fallbackChain(sharedFallback, mainChoice),
    settings,
    deps.store,
    mainSkillKey,
    sharedCallTimeoutMs,
    mainTimeoutKey,
  );

  if (settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined) {
    const now = deps.now ? deps.now() : new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const budget = settings.monthlyBudgetUsd;
    // Reviews admitted before this one and still running have not recorded their cost: each
    // holds its paid bots × the per-review budget until it finishes (first come, first served).
    // A subscription bot with no API keys costs nothing extra, so it holds nothing (ADR-0027).
    const admission = deps.budgetAdmission ?? processBudgetAdmission;
    // Snapshot each provider once for both admission passes (ADR-0035).
    const providers = new Map<string, Promise<boolean>>();
    const isFree = (provider: string) => {
      let free = providers.get(provider);
      if (!free) {
        free = reviewUsesSubscriptionAdmission(deps.credentials, workspaceId, provider);
        providers.set(provider, free);
      }
      return free;
    };
    const plans = await Promise.all(runs.map(async (br) => {
      const isMain = br.bot.slot === MAIN_BOT_SLOT;
      const own = isMain ? mainChoice : br.bot;
      const fallbacks = fallbackChain(isMain ? settings.fallback ?? [] : br.bot.fallback, own);
      const ownFree = await isFree(own.provider);
      const paidFallbacks = (await Promise.all(fallbacks.map(async ({ provider }) =>
        provider !== own.provider && !(await isFree(provider)) ? provider : null,
      ))).filter((provider) => provider !== null);
      return { ownFree, paidFallbacks };
    }));
    const perReviewUsd = mainConfig.effectiveConfig.budget.perReviewUsd;
    const base = plans.filter((plan) => !plan.ownFree).length * perReviewUsd;
    const extra = plans.filter((plan) => plan.ownFree && plan.paidFallbacks.length > 0).length * perReviewUsd;
    const reserve = async (amount: number, requireFit: boolean) =>
      await admission.admit(workspaceId, amount, async (reservedUsd) => {
        const spent = await deps.store.monthCostUsd(workspaceId, monthStart);
        // Preserve ADR-0022 for ordinary paid bots; only the extra fallback reservation must fit.
        return spent + reservedUsd < budget && (!requireFit || spent + reservedUsd + amount <= budget);
      }) ?? undefined;
    let free = plans.map((plan) => plan.ownFree && plan.paidFallbacks.length === 0);
    releaseBudget = await reserve(base + extra, extra > 0);
    if (!releaseBudget && extra > 0) {
      free = plans.map((plan) => plan.ownFree);
      releaseBudget = await reserve(base, false);
    }
    runs.forEach((br, index) => {
      br.admittedFree = free[index] === true;
      if (br.admittedFree) br.skipPaidFallbacks = plans[index]!.paidFallbacks;
    });
    if (!releaseBudget) {
      for (const br of runs) {
        const own = br === publisher ? mainChoice : br.bot;
        let reviewUrl: string | null = null;
        if (br === publisher) {
          const config = mainConfig.effectiveConfig;
          const summaryMarkdown = renderReviewSummary({
            language: config.language, summary: '', summaryOnly: [], inlineCount: 0, complete: false,
            incompleteReasons: [BUDGET_REACHED], modelLabel: config.model ?? config.provider,
            outcome: 'skipped-budget', reason: BUDGET_REACHED,
          });
          const publishResult = await publishReview(client, {
            owner, repo, pull_number: job.pullNumber, expectedHeadSha: job.headSha, summaryMarkdown, inline: [],
            configHash: mainConfig.configHash, language: config.language, suggestionsAsCode: false, publisherLogin,
            botSlot: publisherSlot,
          });
          reviewUrl = 'reviewId' in publishResult && typeof publishResult.reviewId === 'number'
            ? `https://github.com/${owner}/${repo}/pull/${job.pullNumber}#pullrequestreview-${publishResult.reviewId}`
            : null;
        }
        await deps.store.finishReviewRun(workspaceId, br.run.id, {
          status: 'skipped', costUsd: null, detail: BUDGET_REACHED,
          provider: own.provider, model: own.model, effort: own.effort,
          fallbackFrom: null, findingsCount: 0, result: null, reviewUrl,
        });
        br.stopHeartbeat();
      }
      logSkip(BUDGET_REACHED, `Monthly budget reached for workspace ${workspaceId}; skipping`, { runId: lead.run.id, botSlot: lead.bot.slot, workspaceId });
      return { result: { status: 'skipped', detail: BUDGET_REACHED } };
    }
  }

  let judgePrices: Awaited<ReturnType<typeof judgePriceLookup>>;
  let prFiles: Awaited<ReturnType<typeof listPullRequestFiles>>['files'] | undefined;
  try {
    // Judge prices (workspace override, then catalog; ADR-0016), read once for every bot's judge.
    judgePrices = await judgePriceLookup(deps.store, settings);
    // The panel lists the PR's files once for every bot; a lone main bot lists them itself.
    if (panelActive) {
      const listed = await listPullRequestFiles(client, { owner, repo, pull_number: job.pullNumber });
      // A file whose diff is too big for GitHub's files API comes without a patch (ADR-0045): its
      // patch is rebuilt from the file contents, so the bots see the file at all.
      const rebuilt = await rebuildMissingPatches(client, listed.files, {
        owner,
        repo,
        baseSha: job.baseSha,
        headSha: job.headSha,
        exclude: mainConfig.effectiveConfig.review.exclude,
      });
      prFiles = rebuilt.files;
      if (rebuilt.rebuilt.length > 0 || rebuilt.failed.length > 0) {
        const message = `Rebuilt ${rebuilt.rebuilt.length} missing patches, failed ${rebuilt.failed.length}`;
        deps.log?.(message);
        logger.info(
          { event: 'patches.rebuilt', rebuilt: rebuilt.rebuilt.length, failed: rebuilt.failed.map((f) => f.path) },
          message,
        );
      }
    }
  } catch (error) {
    releaseBudget?.(); // the job never reaches the caller's release
    throw error;
  }

  return {
    ctx: {
      ...base, settings, publisherSlot, owner, repo, client, publisherLogin, prTitle, prBody, repoConfigResult,
      mainChoice, mainConfig, judgePrices, panelActive, prFiles, baseUrl: deps.baseUrl, startTime,
    },
    releaseBudget,
  };
}


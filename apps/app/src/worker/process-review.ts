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
import { noteNothingNew } from './nothing-new-note.js';
import { panelTimeoutKeyOf } from './panel-timeout-key.js';
import { closeRuns, loadBotSkills, panelBots, runPanel, startBotRuns, type StartedRuns } from './panel.js';
import { skillKeyOf } from './effective-config.js';
import type { BotRun, PanelContext } from './panel-types.js';
import { reviewUsesSubscriptionAdmission } from './dual-method-review.js';
import { failBotRun, WORKSPACE_DELETED } from './review-bot.js';
import { guardWritesForWorkspace } from './workspace-guard.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

/** Run detail when another job already holds an active run for this head (and bot). */
export const DUPLICATE = 'duplicate';
const BUDGET_REACHED = 'monthly budget reached';

/**
 * One review job per PR head. The shared steps run once (installation, settings, run rows, PR,
 * pause, repo config, monthly budget); then the main bot and every active extra bot of the
 * reviewer panel review in parallel (ADR-0017). The job reports the main bot's result. With no
 * active extra bot this is exactly the single-bot review.
 */
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

  const extras = await deps.store.listReviewerBots(workspaceId);
  const skills = await loadBotSkills(deps.store, workspaceId, [settings.skillId, ...extras.filter((b) => b.active).map((b) => b.skillId)]);
  const bots = panelBots(settings, extras, skills);
  const panelActive = bots.length > 1;
  const mode = settings.panelMode ?? DEFAULT_PANEL_MODE;
  const consensusMode = panelActive && mode === 'consensus';
  // Slot 1's marker hash holds its own skill; in consensus, where the panel selects files once with
  // that marker, the skills of every bot (ADR-0034) and every active bot's explicit call timeout
  // (`panelTimeoutKeyOf`) are part of it. Each bot's own override then extends only its own hash.
  const mainSkillKey = skillKeyOf(consensusMode ? bots : bots.filter((b) => b.slot === MAIN_BOT_SLOT));
  const mainTimeoutKey = consensusMode ? panelTimeoutKeyOf(bots) : undefined;
  if (panelActive) {
    logger.info(
      { event: 'panel.start', jobId: job.deliveryId, bots: bots.map((b) => b.slot), mode },
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
    logSkip(DUPLICATE, `Skipping job ${job.deliveryId}${bot}: a run for this head is already active`, slot === MAIN_BOT_SLOT ? {} : { botSlot: slot });
  }
  const runs = started.running;
  const main = runs.find((br) => br.bot.slot === MAIN_BOT_SLOT);
  const duplicate: ProcessReviewResult = { status: 'skipped', detail: DUPLICATE };
  const lead = main ?? runs[0];
  if (!lead) return duplicate;
  // Consensus publishes as slot 1: without its run (another job holds it), this job must not
  // race that job's publication, so the extra bots it started are closed as duplicates.
  if (!main && panelActive && mode === 'consensus') {
    for (const br of runs) {
      br.stopHeartbeat();
      await deps.store.finishReviewRun(workspaceId, br.run.id, { status: 'skipped', costUsd: null, detail: DUPLICATE });
    }
    logSkip(DUPLICATE, `Skipping job ${job.deliveryId}: the main bot's run for this head is active elsewhere (consensus)`);
    return duplicate;
  }

  let releaseBudget: (() => void) | undefined;
  try {
    logger.info({
      event: 'job.start', jobId: job.deliveryId, runId: lead.run.id, workspace: workspaceId,
      repo: job.repoFullName, pullNumber: job.pullNumber, headSha: job.headSha.slice(0, 7),
    }, `Review job ${job.deliveryId} started for ${job.repoFullName}#${job.pullNumber}`);

    let ctx: PanelContext;
    try {
      const shared = await sharedSteps({ ...base, settings }, runs, main, lead, logSkip, startTime, panelActive, mainSkillKey, mainTimeoutKey);
      if ('result' in shared) return shared.result;
      releaseBudget = shared.releaseBudget;
      ctx = { ...shared.ctx, mode };
    } catch (error) {
      const results = await Promise.all(
        runs.map((br) =>
          failBotRun(base, br, error, [], { provider: br.bot.provider, model: br.bot.model, effort: br.bot.effort }),
        ),
      );
      return main ? results[runs.indexOf(main)]! : duplicate;
    }

    const results = await runPanel(ctx, runs, started.noKey);
    await noteNothingNew(ctx, results);
    await noteBudgetSkipped(ctx, results);
    return results.get(MAIN_BOT_SLOT) ?? duplicate;
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
  shared: Pick<PanelContext, 'job' | 'deps' | 'logger' | 'workspaceId' | 'settings'>,
  runs: BotRun[],
  main: BotRun | undefined,
  lead: BotRun,
  logSkip: (reason: string, message: string, fields?: Record<string, unknown>) => void,
  startTime: number,
  panelActive: boolean,
  mainSkillKey: string | undefined,
  mainTimeoutKey: string | undefined,
): Promise<SharedOutcome> {
  const { settings, ...base } = shared;
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
    logSkip('paused', `Skipping job ${job.deliveryId}: ${PAUSED_DETAIL}`, { runId: lead.run.id });
    return { result: { status: 'skipped', detail: PAUSED_DETAIL } };
  }
  const prRecord = pr as unknown as { title?: string; body?: string | null; additions?: number; deletions?: number };
  const prTitle = typeof prRecord.title === 'string' ? prRecord.title : '';
  const prBody = typeof prRecord.body === 'string' ? prRecord.body : '';

  // Only needed when the main bot runs with a heavy model: no extra GitHub call otherwise.
  const changedLines = settings.heavyModel && main
    ? await changedLinesOf(client, { owner, repo, pull_number: job.pullNumber }, prRecord)
    : 0;
  const mainChoice = chooseModel(settings, changedLines);
  if (mainChoice.heavy) deps.log?.(`Large PR (${changedLines} changed lines): using the heavy-duty model`);

  // The dashboard picks every bot's provider and model, so the repo file may leave them out; the
  // workspace's findings limit applies unless the file names its own `review.maxFindings` (ADR-0033).
  const repoConfigResult = await loadRepoConfig(client, {
    owner,
    repo,
    baseSha: job.baseSha,
    defaults: { provider: mainChoice.provider, model: mainChoice.model, maxFindings: settings.maxFindings, perReviewUsd: settings.perReviewUsd },
  });
  // Slot 1's config, priced for its model (the heavy-duty one when chosen; ADR-0016), with its own
  // call timeout override and — in consensus mode — the panel's timeouts in the marker identity.
  const mainConfig = await buildBotConfig(
    repoConfigResult,
    mainChoice,
    fallbackChain(settings.fallback ?? [], mainChoice),
    settings,
    deps.store,
    mainSkillKey,
    settings.callTimeoutMs,
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
      const own = br === main ? mainChoice : br.bot;
      const fallbacks = fallbackChain(br === main ? settings.fallback ?? [] : br.bot.fallback, own);
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
        const own = br === main ? mainChoice : br.bot;
        let reviewUrl: string | null = null;
        if (br === main) {
          const config = mainConfig.effectiveConfig;
          const summaryMarkdown = renderReviewSummary({
            language: config.language, summary: '', summaryOnly: [], inlineCount: 0, complete: false,
            incompleteReasons: [BUDGET_REACHED], modelLabel: config.model ?? config.provider,
            outcome: 'skipped-budget', reason: BUDGET_REACHED,
          });
          const publishResult = await publishReview(client, {
            owner, repo, pull_number: job.pullNumber, expectedHeadSha: job.headSha, summaryMarkdown, inline: [],
            configHash: mainConfig.configHash, language: config.language, suggestionsAsCode: false, publisherLogin,
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
      logSkip(BUDGET_REACHED, `Monthly budget reached for workspace ${workspaceId}; skipping`, { runId: lead.run.id, workspaceId });
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
      ...base, settings, owner, repo, client, publisherLogin, prTitle, prBody, repoConfigResult,
      mainChoice, mainConfig, judgePrices, panelActive, prFiles, baseUrl: deps.baseUrl, startTime,
    },
    releaseBudget,
  };
}


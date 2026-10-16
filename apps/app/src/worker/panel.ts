import type { Logger } from 'pino';
import {
  ActiveRunExistsError,
  DEFAULT_BOT_LOGO,
  DEFAULT_BOT_NAME,
  MAIN_BOT_SLOT,
  WorkspaceDeletedError,
  type ReviewerBot,
  type ReviewJob,
  type WorkspaceSettings,
} from '../core/types.js';
import { selectBotFiles } from './bot-review-run.js';
import { publishConsensus } from './panel-consensus.js';
import type { BotOutcome, BotRun, PanelBot, PanelContext } from './panel-types.js';
import { failBotRun, finishBotRun, runBot } from './review-bot.js';
import { startRunHeartbeat } from './run-heartbeat.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

export const NO_KEY_DETAIL = 'no key';

/** The main bot (slot 1, the workspace settings) followed by the active extra bots, by slot. */
export function panelBots(settings: WorkspaceSettings, extras: readonly ReviewerBot[]): PanelBot[] {
  const main: PanelBot = {
    slot: MAIN_BOT_SLOT,
    name: settings.botName ?? DEFAULT_BOT_NAME,
    logo: settings.botLogo ?? DEFAULT_BOT_LOGO,
    provider: settings.provider,
    model: settings.model,
    effort: settings.effort ?? null,
    fallback: settings.fallback ?? [],
  };
  const active = extras
    .filter((b) => b.active && b.slot > MAIN_BOT_SLOT)
    .sort((a, b) => a.slot - b.slot)
    .map((b) => ({ slot: b.slot, name: b.name, logo: b.logo, provider: b.provider, model: b.model, effort: b.effort, fallback: b.fallback }));
  return [main, ...active];
}

export interface StartedRuns {
  running: BotRun[];
  /** Slots whose run could not start because another run of the same bot is active on the head. */
  duplicates: number[];
  /** Extra bots recorded as skipped `no key` (their provider has no stored key). */
  noKey: PanelBot[];
}

interface StartContext {
  job: ReviewJob;
  deps: ProcessReviewDeps;
  logger: Logger;
  workspaceId: string;
}

/**
 * Creates every bot's run row (one per bot, all on the job id; ADR-0017) and starts its heartbeat.
 * An extra bot whose provider has no stored key gets a `skipped` run (`no key`) and never runs.
 * `ActiveRunExistsError` skips that slot only. `WorkspaceDeletedError` stops the job: the runs
 * already started are closed and the error is rethrown.
 */
export async function startBotRuns(ctx: StartContext, bots: PanelBot[]): Promise<StartedRuns> {
  const { job, deps, logger, workspaceId } = ctx;
  const started: StartedRuns = { running: [], duplicates: [], noKey: [] };
  const newRun = (bot: PanelBot, initial: { provider: string; model: string; effort: string | null }) => ({
    workspaceId,
    jobId: job.deliveryId,
    installationId: job.installationId,
    repoFullName: job.repoFullName,
    pullNumber: job.pullNumber,
    headSha: job.headSha,
    status: 'running' as const,
    costUsd: null,
    detail: null,
    ...initial,
    botSlot: bot.slot,
    botName: bot.name,
  });
  try {
    for (const bot of bots) {
      const initial = { provider: bot.provider, model: bot.model, effort: bot.effort };
      try {
        if (bot.slot !== MAIN_BOT_SLOT && !(await deps.store.getCredential(workspaceId, bot.provider))) {
          const run = await deps.store.createReviewRun(newRun(bot, initial));
          await deps.store.finishReviewRun(workspaceId, run.id, { status: 'skipped', costUsd: null, detail: NO_KEY_DETAIL, ...initial, findingsCount: 0 });
          logger.info({ event: 'panel.bot.done', jobId: job.deliveryId, slot: bot.slot, status: 'skipped', ms: 0 }, `Bot ${bot.slot} skipped: ${NO_KEY_DETAIL}`);
          started.noKey.push(bot);
          continue;
        }
        const run = await deps.store.createReviewRun(newRun(bot, initial));
        const stopHeartbeat = startRunHeartbeat(deps.store, workspaceId, run.id, {
          intervalMs: deps.heartbeatIntervalMs,
          log: deps.log,
          logger,
        });
        started.running.push({ bot, run, stopHeartbeat, startedAt: performance.now() });
      } catch (error) {
        if (!(error instanceof ActiveRunExistsError)) throw error;
        started.duplicates.push(bot.slot);
      }
    }
    return started;
  } catch (error) {
    if (error instanceof WorkspaceDeletedError) await closeRuns(ctx, started.running, 'workspace_deleted');
    throw error;
  }
}

/** Finishes runs that never reviewed with the same `skipped` detail (pause, budget, deleted). */
export async function closeRuns(ctx: Pick<StartContext, 'deps' | 'workspaceId'>, runs: BotRun[], detail: string): Promise<void> {
  for (const br of runs) {
    br.stopHeartbeat();
    await ctx.deps.store.finishReviewRun(ctx.workspaceId, br.run.id, { status: 'skipped', costUsd: null, detail });
  }
}

/**
 * Runs every bot in parallel; one bot failing never stops the others. Separate mode (and a lone
 * main bot): each bot publishes its own review. Consensus: the bots only review, then one merged
 * review is published as slot 1 and every run is recorded. Returns each bot's result by slot.
 */
export async function runPanel(ctx: PanelContext, runs: BotRun[], noKey: PanelBot[]): Promise<Map<number, ProcessReviewResult>> {
  const consensus = ctx.panelActive && ctx.mode === 'consensus';
  const files = consensus
    ? await selectBotFiles({
        client: ctx.client,
        owner: ctx.owner,
        repo: ctx.repo,
        pullNumber: ctx.job.pullNumber,
        headSha: ctx.job.headSha,
        baseSha: ctx.job.baseSha,
        configHash: ctx.mainConfig.configHash,
        publisherLogin: ctx.publisherLogin,
        log: ctx.deps.log,
        botSlot: MAIN_BOT_SLOT,
        prFiles: ctx.prFiles,
        ...(ctx.job.force ? { force: true } : {}),
      })
    : undefined;

  const settled = await Promise.allSettled(
    runs.map(async (br) => {
      const outcome = await runBot(ctx, br, files);
      if (ctx.panelActive) {
        ctx.logger.info(
          { event: 'panel.bot.done', jobId: ctx.job.deliveryId, slot: br.bot.slot, status: outcome.result.status, ms: Math.round(performance.now() - br.startedAt) },
          `Bot ${br.bot.slot} finished with status ${outcome.result.status}`,
        );
      }
      return outcome;
    }),
  );
  const outcomes: BotOutcome[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { slot: runs[i]!.bot.slot, result: { status: 'failed', detail: 'internal error' } },
  );

  if (consensus) {
    let reviewUrl: string | null;
    try {
      reviewUrl = (await publishConsensus(ctx, runs, outcomes, noKey, files!)).reviewUrl;
    } catch (error) {
      // Publishing failed: every bot that reviewed is recorded as failed with the same reason.
      for (const br of runs) {
        const outcome = outcomes.find((o) => o.slot === br.bot.slot);
        if (!outcome?.pending) continue;
        const { provider, model, effort } = outcome.pending.finish;
        const choice = { provider: provider ?? br.bot.provider, model: model ?? br.bot.model, effort: effort ?? null };
        outcome.result = await failBotRun(ctx, br, error, outcome.pending.knownSecrets, choice as Parameters<typeof failBotRun>[4]);
      }
      return new Map(outcomes.map((o) => [o.slot, o.result]));
    }
    for (const br of runs) {
      const outcome = outcomes.find((o) => o.slot === br.bot.slot);
      const pending = outcome?.pending;
      if (!outcome || !pending) continue;
      const finish = { ...pending.finish, reviewUrl };
      await finishBotRun(ctx, br, finish, pending.outcome.runResult);
      outcome.result = {
        status: finish.status,
        costUsd: finish.costUsd,
        detail: finish.detail,
        ...(pending.outcome.outcome === 'skipped-budget' ? { skippedForBudget: true as const } : {}),
      };
    }
  }
  if (ctx.panelActive && !consensus) {
    const findings = outcomes.reduce((n, o) => n + (o.findings ?? 0), 0);
    ctx.logger.info({ event: 'panel.publish', jobId: ctx.job.deliveryId, mode: 'separate', findings }, 'Reviewer panel published separately');
  }
  return new Map(outcomes.map((o) => [o.slot, o.result]));
}

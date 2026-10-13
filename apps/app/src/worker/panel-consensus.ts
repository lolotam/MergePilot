import {
  deduplicateFindings,
  judgeBudgetLeft,
  mergePanelFindings,
  publishReview,
  renderPanelSummary,
  reviewScopeOf,
  withFoundBy,
  type PanelBotRow,
} from '@mergepilot/github';
import { MAIN_BOT_SLOT } from '../core/types.js';
import type { BotFiles } from './bot-review-run.js';
import { capturingReviewUrl, reviewUrlOf } from './execute-review.js';
import { workspaceJudge } from './judge-setup.js';
import type { BotOutcome, BotRun, PanelBot, PanelContext } from './panel-types.js';

export interface ConsensusPublish {
  /** The merged review's link; null when nothing was published. */
  reviewUrl: string | null;
}

/**
 * Consensus mode (ADR-0017): merges the findings of every bot that completed, drops what is
 * below the minimum agreement (except critical and high, and listed in the summary), and
 * publishes one review as slot 1 under «Review panel». Publishes nothing when no bot completed.
 * The judge's same-issue cost is added to the record of the bot whose run carries the review
 * (slot 1 when it completed, otherwise the lowest completed slot).
 */
export async function publishConsensus(
  ctx: PanelContext,
  runs: BotRun[],
  outcomes: BotOutcome[],
  noKey: PanelBot[],
  files: BotFiles,
): Promise<ConsensusPublish> {
  const { settings, logger, job } = ctx;
  const language = settings.language;
  const completed = runs.flatMap((br) => {
    const pending = outcomes.find((o) => o.slot === br.bot.slot)?.pending;
    const rr = pending?.outcome.runResult;
    return pending && pending.finish.status === 'completed' && rr?.status === 'completed' ? [{ br, pending, rr }] : [];
  });
  if (completed.length === 0) {
    logger.info({ event: 'panel.publish', jobId: job.deliveryId, mode: 'consensus', findings: 0 }, 'Reviewer panel: no bot completed; nothing published');
    return { reviewUrl: null };
  }

  const knownSecrets = completed.flatMap((c) => c.pending.knownSecrets);
  const holder = completed.find((c) => c.br.bot.slot === MAIN_BOT_SLOT) ?? completed[0]!;
  const judgeSetup = await workspaceJudge(settings, ctx.workspaceId, ctx.deps.credentials, logger, {
    jobId: job.deliveryId,
    runId: holder.br.run.id,
    fetch: ctx.deps.judgeFetch,
    priceLookup: ctx.judgePrices,
  });
  knownSecrets.push(...judgeSetup.secrets);
  const judge = judgeSetup.judge;
  const budget = () => judgeBudgetLeft(ctx.mainConfig.effectiveConfig, undefined, judge);

  const merge = await mergePanelFindings({
    bots: completed.map(({ br, rr }) => ({ slot: br.bot.slot, name: br.bot.name, inline: rr.inline, summaryOnly: rr.summaryOnly })),
    minAgreement: settings.panelMinAgreement ?? 1,
    judge: judge?.judge,
    knownSecrets,
    maxUsd: judge ? budget() : undefined,
  });
  const merged = merge.kept.filter((c) => c.kind === 'inline').map((c) => withFoundBy(c, merge.total, language));
  const deduped = await deduplicateFindings(ctx.client, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: job.pullNumber,
    publisherLogin: ctx.publisherLogin,
    findings: merged,
    judge: judge?.judge,
    knownSecrets,
    maxUsd: judge ? budget() : undefined,
    botSlot: MAIN_BOT_SLOT,
  });
  addJudgeUsage(holder.pending, judge?.judge.report());

  const rows: PanelBotRow[] = [
    ...runs.map((br) => row(br.bot, outcomes.find((o) => o.slot === br.bot.slot))),
    ...noKey.map((bot) => ({ slot: bot.slot, name: bot.name, logo: bot.logo, modelLabel: `${bot.provider}:${bot.model}`, status: 'skipped' as const })),
  ].sort((a, b) => a.slot - b.slot);
  // The panel's review is complete only when every bot that ran completed: a bot that failed
  // never looked at these changes, so the head must not count as reviewed for the whole panel.
  const incompleteReasons = [
    ...completed.flatMap(({ br, rr }) =>
      rr.complete ? [] : [`${br.bot.name}: ${rr.result.incompleteReasons.join('; ') || 'incomplete'}`],
    ),
    ...rows.filter((r) => r.status === 'failed').map((r) => `${r.name}: did not complete`),
  ];
  const summaryMarkdown = renderPanelSummary({
    language,
    baseUrl: ctx.baseUrl,
    bots: rows,
    merge,
    minAgreement: settings.panelMinAgreement ?? 1,
    inlineCount: deduped.kept.length,
    scope: reviewScopeOf(files.selection),
    incompleteReasons,
    judgeUnavailable: merge.semantic?.unavailable,
  });

  const capture = capturingReviewUrl(ctx.client);
  const publish = await publishReview(capture.client, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: job.pullNumber,
    expectedHeadSha: job.headSha,
    summaryMarkdown,
    inline: deduped.kept,
    configHash: ctx.mainConfig.configHash,
    language,
    suggestionsAsCode: false,
    publisherLogin: ctx.publisherLogin,
    partial: incompleteReasons.length > 0,
    alreadyDeduplicated: true,
    botSlot: MAIN_BOT_SLOT,
  });
  ctx.deps.log?.(`Review panel publication outcome: ${publish.status}`);
  const findings = deduped.kept.length + merge.kept.filter((c) => c.kind === 'summaryOnly').length;
  logger.info({ event: 'panel.publish', jobId: job.deliveryId, mode: 'consensus', findings }, `Reviewer panel published ${findings} findings`);
  return { reviewUrl: reviewUrlOf(publish, capture.url(), { owner: ctx.owner, repo: ctx.repo, pullNumber: job.pullNumber }) };
}

function row(bot: PanelBot, outcome: BotOutcome | undefined): PanelBotRow {
  const finish = outcome?.pending?.finish;
  const status = finish?.status ?? outcome?.result.status ?? 'failed';
  return {
    slot: bot.slot,
    name: bot.name,
    logo: bot.logo,
    modelLabel: outcome?.pending?.modelLabel ?? `${bot.provider}:${bot.model}`,
    status: status === 'completed' || status === 'skipped' ? status : 'failed',
    findings: finish?.findingsCount ?? null,
    costUsd: finish?.costUsd ?? null,
    summary: outcome?.pending?.outcome.runResult?.status === 'completed' ? outcome.pending.outcome.runResult.summary : undefined,
  };
}

/** Adds the merge judge's tokens and known cost to the record of the bot carrying the review. */
function addJudgeUsage(
  pending: NonNullable<BotOutcome['pending']>,
  report: { attempts: unknown[]; inputTokens: number; outputTokens: number; costUsd?: number | undefined } | undefined,
): void {
  if (!report || report.attempts.length === 0) return;
  const finish = pending.finish;
  // Known only when both parts are: an unpriced bot run or an unpriced judge leaves it unknown.
  finish.costUsd =
    finish.costUsd === null || finish.costUsd === undefined || report.costUsd === undefined
      ? null
      : finish.costUsd + report.costUsd;
  const usage = finish.result?.usage;
  if (finish.result && usage) {
    finish.result = {
      ...finish.result,
      usage: { inputTokens: usage.inputTokens + report.inputTokens, outputTokens: usage.outputTokens + report.outputTokens },
    };
  }
}

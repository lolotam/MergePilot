import type { ConsensusCluster, PanelBotFindings } from './consensus.js';

/**
 * Where one bot's findings went after the consensus merge (ADR-0034 amendment), so the summary can
 * explain a bots-table count that is higher than what the bot has on the PR. Each of a bot's
 * findings is in exactly one cluster (a cluster holds at most one finding per bot), so the parts
 * add up to `reported`.
 */
export interface BotFindingsFate {
  slot: number;
  name: string;
  /** The bot's findings after its own verification and selection: its count in the bots table. */
  reported: number;
  /** Published with this bot's own wording. */
  own: number;
  /** Published once, with the wording of another bot that found the same issue. */
  mergedIntoOther: number;
  /** Fewer bots than the minimum agreement found it. */
  below: number;
  /** Left out by `review.maxFindings`. */
  overLimit: number;
  /** Already on the PR as a comment of an earlier review (dropped by the duplicate check). */
  alreadyPosted: number;
}

/** Every cluster of the merge, by what happened to it. */
export interface PanelClusterOutcome {
  published: readonly ConsensusCluster[];
  below: readonly ConsensusCluster[];
  overLimit: readonly ConsensusCluster[];
  alreadyPosted: readonly ConsensusCluster[];
}

/** For each bot that completed, where its findings went. */
export function botFindingsFates(bots: readonly PanelBotFindings[], outcome: PanelClusterOutcome): BotFindingsFate[] {
  return bots.map((bot) => {
    const foundByBot = (cluster: ConsensusCluster): boolean => cluster.foundBy.some((b) => b.slot === bot.slot);
    const count = (clusters: readonly ConsensusCluster[]): number => clusters.filter(foundByBot).length;
    const ownFindings = new Set([...bot.inline, ...bot.summaryOnly]);
    const published = outcome.published.filter(foundByBot);
    // The cluster shows its representative finding, which is the bot's own object when it won.
    const own = published.filter((cluster) => ownFindings.has(cluster.finding)).length;
    return {
      slot: bot.slot,
      name: bot.name,
      reported: bot.inline.length + bot.summaryOnly.length,
      own,
      mergedIntoOther: published.length - own,
      below: count(outcome.below),
      overLimit: count(outcome.overLimit),
      alreadyPosted: count(outcome.alreadyPosted),
    };
  });
}

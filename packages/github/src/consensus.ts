import {
  judgeSameIssue,
  SEVERITY_RANK,
  type Finding,
  type Judge,
  type SameIssuePair,
  type Secret,
} from '@mergepilot/engine';
import { escapeInline } from './bot-identity.js';
import { sameClaimScore } from './claim-similarity.js';
import { normalizeTitle } from './dedupe.js';

/**
 * Consensus mode of the reviewer panel (ADR-0017): the findings of every bot that completed are
 * merged into clusters. A cluster is findings on the same path with start lines within ±3 and
 * either the same normalized title, the same claim by wording (`sameClaimScore`), or, when a judge
 * is supplied, a "same issue?" answer of 0.8 or more, applied in that order. The wording rule needs
 * no judge, so a judge that is off, over budget or unavailable never splits a duplicate the words
 * already show. A cluster holds at most one finding per bot: a bot never agrees with itself, so two
 * findings of one bot are never chained into one cluster. Each cluster keeps its most severe
 * version and the bots that found it. Clusters found by fewer than `minAgreement` bots are set
 * aside, except critical and high ones, and returned so the summary can list them: nothing is
 * dropped silently. The kept clusters are then capped at
 * `maxFindings`, the published review's findings limit (ADR-0033); the clusters over it are
 * returned for the summary too.
 */

export const CONSENSUS_LINE_WINDOW = 3;
/** Most candidate pairs sent to the judge in its one request. */
export const MAX_CONSENSUS_PAIRS = 50;

export interface PanelBotFindings {
  slot: number;
  name: string;
  inline: Finding[];
  summaryOnly: Finding[];
}

export type ClusterKind = 'inline' | 'summaryOnly';

export interface ConsensusCluster {
  /** The most severe version (ties: the lowest slot). Its body is the bot's own. */
  finding: Finding;
  kind: ClusterKind;
  /** The distinct bots that found it, by slot. */
  foundBy: Array<{ slot: number; name: string }>;
}

export interface MergePanelInput {
  /** The bots that completed their review. */
  bots: PanelBotFindings[];
  minAgreement: number;
  /** Most clusters the published review keeps; undefined keeps every agreed cluster. */
  maxFindings?: number | undefined;
  judge?: Judge | undefined;
  knownSecrets?: readonly Secret[] | undefined;
  maxUsd?: number | undefined;
}

export interface MergePanelResult {
  kept: ConsensusCluster[];
  /** Below the minimum agreement (never critical or high). */
  below: ConsensusCluster[];
  /** Agreed clusters left out by `maxFindings`: the least severe, then those the fewest bots found. */
  overLimit: ConsensusCluster[];
  /** How many bots completed: the N of "n/N". */
  total: number;
  /** Set when the judge was asked (or failed). */
  semantic?: { checked: number; merged: number; unavailable?: string | undefined } | undefined;
}

interface Entry {
  slot: number;
  name: string;
  kind: ClusterKind;
  finding: Finding;
}

const ALWAYS_KEPT = new Set<Finding['severity']>(['critical', 'high']);

export async function mergePanelFindings(input: MergePanelInput): Promise<MergePanelResult> {
  const entries: Entry[] = input.bots.flatMap((bot) => [
    ...bot.inline.map((finding) => ({ slot: bot.slot, name: bot.name, kind: 'inline' as const, finding })),
    ...bot.summaryOnly.map((finding) => ({ slot: bot.slot, name: bot.name, kind: 'summaryOnly' as const, finding })),
  ]);
  const clusters = new BotClusters(entries.map((e) => e.slot));
  // Strongest evidence first, so a weaker match never takes a bot's place in a cluster that an
  // exact title would have earned: the same title, then the wording rule by score, then the judge.
  const { byTitle, byClaim, undecided } = candidatePairs(entries);
  for (const [a, b] of byTitle) clusters.join(a, b);
  for (const { a, b } of byClaim.sort((x, y) => y.score - x.score)) clusters.join(a, b);
  const semantic = input.judge
    ? await joinByJudge(entries, clusters, undecided, { ...input, judge: input.judge })
    : undefined;

  const groups = new Map<number, Entry[]>();
  entries.forEach((entry, i) => {
    const root = clusters.root(i);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  });

  const agreed: ConsensusCluster[] = [];
  const below: ConsensusCluster[] = [];
  for (const group of groups.values()) {
    const cluster = toCluster(group);
    const enough = cluster.foundBy.length >= input.minAgreement;
    (enough || ALWAYS_KEPT.has(cluster.finding.severity) ? agreed : below).push(cluster);
  }
  const { kept, overLimit } = capConsensusClusters(agreed.sort(byImportance), input.maxFindings);
  return { kept, below: below.sort(byImportance), overLimit, total: input.bots.length, ...(semantic ? { semantic } : {}) };
}

/**
 * The `max` clusters to publish, most severe first and then those most bots found; order kept. A
 * caller that drops clusters after the merge (already published ones) caps the survivors with it.
 */
export function capConsensusClusters(
  clusters: ConsensusCluster[],
  max: number | undefined,
): { kept: ConsensusCluster[]; overLimit: ConsensusCluster[] } {
  if (max === undefined || clusters.length <= max) return { kept: clusters, overLimit: [] };
  const ranked = [...clusters].sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      b.foundBy.length - a.foundBy.length ||
      byImportance(a, b),
  );
  const chosen = new Set(ranked.slice(0, max));
  return { kept: clusters.filter((c) => chosen.has(c)), overLimit: clusters.filter((c) => !chosen.has(c)) };
}

/** Union-find over the entries in which a cluster never holds two findings of one bot. */
class BotClusters {
  private readonly parent: number[];
  private readonly slots: Array<Set<number>>;

  constructor(entrySlots: readonly number[]) {
    this.parent = entrySlots.map((_, i) => i);
    this.slots = entrySlots.map((slot) => new Set([slot]));
  }

  root(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]!]!;
    return i;
  }

  /** Whether the two entries are in different clusters that have no bot in common. */
  canJoin(a: number, b: number): boolean {
    const ra = this.root(a);
    const rb = this.root(b);
    return ra !== rb && ![...this.slots[ra]!].some((slot) => this.slots[rb]!.has(slot));
  }

  /** Joins the two entries' clusters when `canJoin` allows it; returns whether it did. */
  join(a: number, b: number): boolean {
    if (!this.canJoin(a, b)) return false;
    const ra = this.root(a);
    const rb = this.root(b);
    this.parent[ra] = rb;
    for (const slot of this.slots[ra]!) this.slots[rb]!.add(slot);
    return true;
  }
}

type EntryPair = [number, number];

/** Nearby pairs of different bots' findings, by what matched them. */
function candidatePairs(entries: readonly Entry[]): {
  byTitle: EntryPair[];
  byClaim: Array<{ a: number; b: number; score: number }>;
  undecided: EntryPair[];
} {
  const byTitle: EntryPair[] = [];
  const byClaim: Array<{ a: number; b: number; score: number }> = [];
  const undecided: EntryPair[] = [];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const fa = entries[a]!.finding;
      const fb = entries[b]!.finding;
      if (!nearby(entries[a]!, entries[b]!)) continue;
      if (sameTitle(fa, fb)) {
        byTitle.push([a, b]);
        continue;
      }
      const score = sameClaimScore(fa, fb);
      if (score === undefined) undecided.push([a, b]);
      else byClaim.push({ a, b, score });
    }
  }
  return { byTitle, byClaim, undecided };
}

/**
 * Asks the judge, in one request, about the undecided pairs that could still join: a pair already
 * in one cluster, or whose clusters share a bot, is not asked. `merged` counts the joins made.
 */
async function joinByJudge(
  entries: readonly Entry[],
  clusters: BotClusters,
  undecided: readonly EntryPair[],
  input: MergePanelInput & { judge: Judge },
): Promise<MergePanelResult['semantic']> {
  const asked = undecided.filter(([a, b]) => clusters.canJoin(a, b)).slice(0, MAX_CONSENSUS_PAIRS);
  if (asked.length === 0) return undefined;
  const pairs: SameIssuePair[] = asked.map(([a, b], i) => {
    const fa = entries[a]!.finding;
    const fb = entries[b]!.finding;
    return {
      key: `c${i + 1}`,
      newComment: { path: fa.path, line: fa.line, title: fa.title, body: fa.body },
      existingComment: { path: fb.path, line: fb.line, body: `${fb.title}\n\n${fb.body}` },
    };
  });
  const outcome = await judgeSameIssue({
    judge: input.judge,
    pairs,
    knownSecrets: input.knownSecrets ?? [],
    maxUsd: input.maxUsd,
  });
  let merged = 0;
  asked.forEach(([a, b], i) => {
    if (outcome.duplicates.has(`c${i + 1}`) && clusters.join(a, b)) merged++;
  });
  return { checked: outcome.checked, merged, ...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}) };
}

function nearby(a: Entry, b: Entry): boolean {
  return (
    a.slot !== b.slot &&
    a.kind === b.kind &&
    a.finding.path === b.finding.path &&
    Math.abs(a.finding.line - b.finding.line) <= CONSENSUS_LINE_WINDOW
  );
}

function sameTitle(a: Finding, b: Finding): boolean {
  const ta = normalizeTitle(a.title);
  return ta.length > 0 && ta === normalizeTitle(b.title);
}

function toCluster(group: Entry[]): ConsensusCluster {
  const best = [...group].sort(
    (a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.slot - b.slot,
  )[0]!;
  const bots = new Map<number, string>();
  for (const e of group) bots.set(e.slot, e.name);
  const foundBy = [...bots.entries()].sort((a, b) => a[0] - b[0]).map(([slot, name]) => ({ slot, name }));
  return { finding: best.finding, kind: best.kind, foundBy };
}

function byImportance(a: ConsensusCluster, b: ConsensusCluster): number {
  return (
    SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
    a.finding.path.localeCompare(b.finding.path) ||
    a.finding.line - b.finding.line
  );
}

/** "Found by: A, B (2/3)", localized; bot names are escaped. */
export function foundByLabel(cluster: ConsensusCluster, total: number, language: 'ar' | 'en'): string {
  const names = cluster.foundBy.map((b) => escapeInline(b.name));
  const count = `(${cluster.foundBy.length}/${total})`;
  return language === 'ar' ? `وجدها: ${names.join('، ')} ${count}` : `Found by: ${names.join(', ')} ${count}`;
}

/** The cluster's finding with its "found by" label added to the body, for the inline comment. */
export function withFoundBy(cluster: ConsensusCluster, total: number, language: 'ar' | 'en'): Finding {
  return { ...cluster.finding, body: `${cluster.finding.body}\n\n_${foundByLabel(cluster, total, language)}_` };
}

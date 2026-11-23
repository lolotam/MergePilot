import {
  judgeSameIssue,
  UNSHOWN_CODE_MAX_CONFIDENCE,
  SEVERITY_RANK,
  type Finding,
  type Judge,
  type SameIssuePair,
  type Secret,
} from '@mergepilot/engine';
import { escapeInline } from './bot-identity.js';
import { farFoldScore, foldedPlacesOf, foldSignalsOf, listedPlacesInBody, sameFoldPlace, withFoldedPlaces } from './claim-fold.js';
import { sameClaimScore } from './claim-similarity.js';
import { normalizeTitle } from './dedupe.js';

/**
 * Consensus mode of the reviewer panel (ADR-0017): the findings of every bot that completed are
 * merged into clusters. Nearby candidates are on the same path with start lines within ±3 and
 * either the same normalized title, the same claim by wording (`sameClaimScore`), or, when a judge
 * is supplied, a "same issue?" answer of 0.8 or more, applied in that order. The wording rule needs
 * no judge, so a judge that is off, over budget or unavailable never splits a duplicate the words
 * already show. Kept findings can also fold deterministically across distant anchors (ADR-0056).
 * A cluster holds at most one finding per bot: a bot never agrees with itself, so two
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
  rejected?: Array<{ finding: Finding; reason: string; kind: ClusterKind }> | undefined;
}

export type ClusterKind = 'inline' | 'summaryOnly';

export interface ConsensusCluster {
  /** The most severe version (ties: the lowest slot). Its body is the bot's own. */
  finding: Finding;
  kind: ClusterKind;
  /** The distinct bots that found it, by slot. */
  foundBy: Array<{ slot: number; name: string }>;
  foldedPlaces?: Array<{ path: string; line: number }>;
  foldedTitles?: Array<{ title: string; name: string }>;
  /** Kept members anchored outside the representative's ±3-line window, ordered by severity then slot. */
  distantMembers?: Array<{ slot: number; name: string; finding: Finding }> | undefined;
  rejectedBy?: Array<{ slot: number; finding: Finding }> | undefined;
  revived?: boolean | undefined;
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
  rejected?: boolean;
}

type EntrySignals = ReadonlyMap<Entry, ReturnType<typeof foldSignalsOf>>;

const ALWAYS_KEPT = new Set<Finding['severity']>(['critical', 'high']);

export async function mergePanelFindings(input: MergePanelInput): Promise<MergePanelResult> {
  const entries: Entry[] = input.bots.flatMap((bot) => [
    ...bot.inline.map((finding) => ({ slot: bot.slot, name: bot.name, kind: 'inline' as const, finding })),
    ...bot.summaryOnly.map((finding) => ({ slot: bot.slot, name: bot.name, kind: 'summaryOnly' as const, finding })),
    ...(bot.rejected ?? []).map(({ finding, kind }) => ({ slot: bot.slot, name: bot.name, kind, finding, rejected: true })),
  ]);
  const clusters = new BotClusters(entries.map((e) => e.slot));
  // Kept-to-kept deterministic matches reserve bot slots before rejected copies can consume them.
  // Within each tier, exact titles precede wording matches; the judge follows both tiers.
  const { byTitle, byClaim, byFar, undecided, signals } = candidatePairs(entries);
  const hasRejected = (a: number, b: number): boolean => Boolean(entries[a]!.rejected || entries[b]!.rejected);
  const rankedClaims = byClaim.sort((x, y) => y.score - x.score);
  const rankedFar = byFar.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  for (const tier of ['kept', 'rejected'] as const) {
    const inTier = (a: number, b: number): boolean => hasRejected(a, b) === (tier === 'rejected');
    for (const [a, b] of byTitle) if (inTier(a, b)) clusters.join(a, b);
    for (const { a, b } of rankedClaims) if (inTier(a, b)) clusters.join(a, b);
    if (tier === 'kept') {
      for (const { a, b } of rankedFar) clusters.join(a, b);
    }
  }
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
    // A cluster holds at most one finding per bot, so its length is the number of bots that raised it.
    if (group.every((entry) => entry.rejected) && group.length < 2) continue;
    const cluster = toCluster(group, signals);
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
type RankedPair = { a: number; b: number; score: number };

/** Pairs of different bots' findings, by what matched them and whether they can go to the judge. */
function candidatePairs(entries: readonly Entry[]): {
  byTitle: EntryPair[];
  byClaim: RankedPair[];
  byFar: RankedPair[];
  undecided: EntryPair[];
  signals: EntrySignals;
} {
  const byTitle: EntryPair[] = [];
  const byClaim: RankedPair[] = [];
  const byFar: RankedPair[] = [];
  const undecided: EntryPair[] = [];
  const knownPaths = [...new Set(entries.map(({ finding }) => finding.path))];
  const signals = new Map(entries.filter(({ rejected }) => !rejected)
    .map((entry) => [entry, foldSignalsOf(entry.finding, knownPaths)] as const));
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const left = entries[a]!;
      const right = entries[b]!;
      if (left.slot === right.slot || left.kind !== right.kind) continue;
      if (!nearby(left, right)) {
        const sa = signals.get(left);
        const sb = signals.get(right);
        const score = sa && sb ? farFoldScore(sa, sb) : undefined;
        if (score !== undefined) byFar.push({ a, b, score });
        continue;
      }
      const fa = left.finding;
      const fb = right.finding;
      if (sameTitle(fa, fb)) {
        byTitle.push([a, b]);
        continue;
      }
      const score = sameClaimScore(fa, fb);
      if (score === undefined) undecided.push([a, b]);
      else byClaim.push({ a, b, score });
    }
  }
  return { byTitle, byClaim, byFar, undecided, signals };
}

/**
 * Asks the judge, in one request, about the undecided pairs that could still join: a pair already
 * in one cluster, or whose clusters share a bot, is not asked. Pairs of kept findings come first,
 * so rejected copies never take a place in the pair limit that kept findings had (ADR-0050).
 * `merged` counts the joins made.
 */
async function joinByJudge(
  entries: readonly Entry[],
  clusters: BotClusters,
  undecided: readonly EntryPair[],
  input: MergePanelInput & { judge: Judge },
): Promise<MergePanelResult['semantic']> {
  const hasRejected = ([a, b]: EntryPair): boolean => Boolean(entries[a]!.rejected || entries[b]!.rejected);
  const joinable = undecided.filter(([a, b]) => clusters.canJoin(a, b));
  const asked = [...joinable.filter((p) => !hasRejected(p)), ...joinable.filter(hasRejected)].slice(0, MAX_CONSENSUS_PAIRS);
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
    a.finding.path === b.finding.path &&
    Math.abs(a.finding.line - b.finding.line) <= CONSENSUS_LINE_WINDOW
  );
}

function sameTitle(a: Finding, b: Finding): boolean {
  const ta = normalizeTitle(a.title);
  return ta.length > 0 && ta === normalizeTitle(b.title);
}

function distinctAlternateTitles(
  representativeTitle: string,
  others: ReadonlyArray<{ slot: number; name: string; finding: Finding }>,
): Array<{ title: string; name: string }> {
  const seen = new Set([normalizeTitle(representativeTitle)]);
  const titles: Array<{ title: string; name: string }> = [];
  for (const { finding, name } of [...others].sort((a, b) => a.slot - b.slot)) {
    const normalized = normalizeTitle(finding.title);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    titles.push({ title: finding.title, name });
    if (titles.length === 3) break;
  }
  return titles;
}

function toCluster(group: Entry[], signals: EntrySignals): ConsensusCluster {
  const verified = group.filter((entry) => !entry.rejected);
  const revived = verified.length === 0;
  const ranked = [...(revived ? group : verified)].sort(
    (a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.slot - b.slot,
  );
  const best = ranked[0]!;
  const bots = new Map<number, string>();
  for (const e of group) bots.set(e.slot, e.name);
  const foundBy = [...bots.entries()].sort((a, b) => a[0] - b[0]).map(([slot, name]) => ({ slot, name }));
  const otherKept = revived ? [] : ranked.slice(1);
  const bestListed = [...(signals.get(best)?.listed ?? []), ...listedPlacesInBody(best.finding.body)];
  const otherPlaces = otherKept.flatMap((entry) => [
    entry.finding,
    ...(signals.get(entry)?.listed ?? []),
    ...listedPlacesInBody(entry.finding.body),
  ]);
  const foldedPlaces = foldedPlacesOf(best.finding, bestListed, otherPlaces);
  const foldedTitles = distinctAlternateTitles(best.finding.title, otherKept);
  const distantMembers = otherKept
    .filter((entry) => !sameFoldPlace(best.finding, entry.finding))
    .map(({ slot, name, finding }) => ({ slot, name, finding }));
  return {
    finding: revived ? { ...best.finding, confidence: Math.min(best.finding.confidence, UNSHOWN_CODE_MAX_CONFIDENCE) } : best.finding,
    kind: best.kind, foundBy,
    ...(foldedPlaces.length > 0 ? { foldedPlaces } : {}),
    ...(foldedTitles.length > 0 ? { foldedTitles } : {}),
    ...(distantMembers.length > 0 ? { distantMembers } : {}),
    ...(group.some((entry) => entry.rejected) ? { rejectedBy: group.filter((entry) => entry.rejected).map((entry) => ({ slot: entry.slot, finding: entry.finding })) } : {}),
    ...(revived ? { revived: true } : {}),
  };
}

/**
 * When a cluster's representative matches an earlier PR comment but a folded distant member is new,
 * promotes the highest-severity surviving distant member so newly found locations are not dropped.
 */
export function promoteSurvivingCluster(
  cluster: ConsensusCluster,
  notYetPosted: ReadonlySet<Finding>,
): ConsensusCluster | null {
  const surviving = (cluster.distantMembers ?? []).filter((member) => notYetPosted.has(member.finding));
  if (surviving.length === 0) return null;
  const nextBest = surviving[0]!;
  const rest = surviving.slice(1);
  const foldedPlaces = foldedPlacesOf(
    nextBest.finding,
    listedPlacesInBody(nextBest.finding.body),
    rest.flatMap((member) => [member.finding, ...listedPlacesInBody(member.finding.body)]),
  );
  const foldedTitles = distinctAlternateTitles(nextBest.finding.title, rest);
  const { foldedPlaces: _fp, foldedTitles: _ft, distantMembers: _dm, ...base } = cluster;
  return {
    ...base,
    finding: nextBest.finding,
    ...(foldedPlaces.length > 0 ? { foldedPlaces } : {}),
    ...(foldedTitles.length > 0 ? { foldedTitles } : {}),
    ...(rest.length > 0 ? { distantMembers: rest } : {}),
  };
}

function byImportance(a: ConsensusCluster, b: ConsensusCluster): number {
  return (
    SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
    a.finding.path.localeCompare(b.finding.path) ||
    a.finding.line - b.finding.line
  );
}

/** "Found by: A, B (2/3)", localized; bot names are escaped. */
export function foundByLabel(
  cluster: ConsensusCluster,
  total: number,
  language: 'ar' | 'en',
  publication: 'published' | 'unpublished' = 'unpublished',
): string {
  const names = cluster.foundBy.map((b) => escapeInline(b.name));
  const count = `(${cluster.foundBy.length}/${total})`;
  const verdict = publication === 'published'
    ? (language === 'ar' ? 'نُشرت رغم رفض التحقق' : 'published although the verifier rejected it')
    : (language === 'ar' ? 'رفضها التحقق' : 'verifier-rejected');
  const marker = cluster.revived ? (language === 'ar'
    ? ` — غير متحققة: ${verdict}؛ رصدها ${cluster.foundBy.length} بوتات بشكل مستقل (لم تمر بفلتر Jev)`
    : ` - Unverified: ${verdict}; raised independently by ${cluster.foundBy.length} bots (not checked by Jev)`) : '';
  return (language === 'ar' ? `وجدها: ${names.join('، ')} ${count}` : `Found by: ${names.join(', ')} ${count}`) + marker;
}

/** The cluster's finding with its "found by" label added to the body, for the inline comment. */
export function withFoundBy(cluster: ConsensusCluster, total: number, language: 'ar' | 'en'): Finding {
  const body = withFoldedPlaces(cluster.finding.body, cluster.foldedPlaces ?? []);
  const foundBy = `_${foundByLabel(cluster, total, language, 'published')}_`;
  if (!cluster.foldedTitles?.length) return { ...cluster.finding, body: `${body}\n\n${foundBy}` };

  const label = language === 'ar' ? 'وردت أيضاً بصياغة' : 'Also raised as';
  const titles = cluster.foldedTitles.map(({ title, name }) => `"${escapeInline(title)}" (${escapeInline(name)})`);
  return { ...cluster.finding, body: `${body}\n\n${foundBy}\n\n_${label}: ${titles.join('; ')}_` };
}

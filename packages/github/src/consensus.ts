import {
  judgeSameIssue,
  SEVERITY_RANK,
  type Finding,
  type Judge,
  type SameIssuePair,
  type Secret,
} from '@mergepilot/engine';
import { escapeInline } from './bot-identity.js';
import { sameClaim } from './claim-similarity.js';
import { normalizeTitle } from './dedupe.js';

/**
 * Consensus mode of the reviewer panel (ADR-0017): the findings of every bot that completed are
 * merged into clusters. A cluster is findings on the same path with start lines within ±3 and
 * either the same normalized title, the same claim by wording (`sameClaim`), or, when a judge is
 * supplied, a "same issue?" answer of 0.8 or more. The wording rule needs no judge, so a judge that
 * is off, over budget or unavailable never splits a duplicate the words already show. A cluster
 * holds at most one finding per bot: a bot never agrees with itself, so two findings of one bot
 * are never chained into one cluster. Each cluster keeps its most severe version and the bots
 * that found it. Clusters found by fewer than `minAgreement` bots are set aside, except critical and high ones, and returned so the
 * summary can list them: nothing is dropped silently. The kept clusters are then capped at
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
  const parent = entries.map((_, i) => i);
  const slots = entries.map((e) => new Set([e.slot]));
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb || [...slots[ra]!].some((slot) => slots[rb]!.has(slot))) return;
    parent[ra] = rb;
    for (const slot of slots[ra]!) slots[rb]!.add(slot);
  };

  const pairs: SameIssuePair[] = [];
  const pairIndex = new Map<string, [number, number]>();
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const ea = entries[a]!;
      const eb = entries[b]!;
      if (!nearby(ea, eb)) continue;
      if (sameTitle(ea.finding, eb.finding) || sameClaim(ea.finding, eb.finding)) {
        union(a, b);
      } else if (input.judge && pairs.length < MAX_CONSENSUS_PAIRS) {
        const key = `c${pairs.length + 1}`;
        pairIndex.set(key, [a, b]);
        pairs.push({
          key,
          newComment: { path: ea.finding.path, line: ea.finding.line, title: ea.finding.title, body: ea.finding.body },
          existingComment: {
            path: eb.finding.path,
            line: eb.finding.line,
            body: `${eb.finding.title}\n\n${eb.finding.body}`,
          },
        });
      }
    }
  }

  let semantic: MergePanelResult['semantic'];
  if (input.judge && pairs.length > 0) {
    const outcome = await judgeSameIssue({
      judge: input.judge,
      pairs,
      knownSecrets: input.knownSecrets ?? [],
      maxUsd: input.maxUsd,
    });
    for (const key of outcome.duplicates) {
      const pair = pairIndex.get(key);
      if (pair) union(pair[0], pair[1]);
    }
    semantic = {
      checked: outcome.checked,
      merged: outcome.duplicates.size,
      ...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}),
    };
  }

  const groups = new Map<number, Entry[]>();
  entries.forEach((entry, i) => {
    const root = find(i);
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

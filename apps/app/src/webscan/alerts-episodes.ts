import type { Severity, Validation } from '@mergepilot/webscan';
import { digest } from './alerts-payload.js';
import type { WebScanAlertEpisode } from './types.js';

/**
 * The bounded episode state of a site (ADR-0052 section 8).
 *
 * An episode is the alert state of one `issue_key`. It is bounded, it is keyed
 * by the issue key and it never depends on the comparison of a scan: a churn of
 * targets, values or subjects joins the episode of its group instead of opening
 * a second issue.
 */

/**
 * The maximum number of episodes one site keeps.
 *
 * The bound is a budget of slots, and the engine admits episodes into it
 * instead of evicting them after the evaluation:
 *
 * - An episode that the state of the site already carries keeps its slot. It
 *   is never evicted for a new one, so the state of an unresolved group never
 *   rotates: the group keeps its episode, and the episode keeps the issue it
 *   already opened.
 * - A new episode is admitted only while a slot is free.
 * - The new candidates compete for the free slots in a deterministic order:
 *   the strongest severity first, then the strongest validation, then the
 *   issue key in the order of its code units.
 * - A new candidate that is not admitted leaves no episode and no action
 *   behind. Its group is offered again on a later scan, when a slot frees up.
 * - A resolved episode releases its slot for a candidate that waits for it: the
 *   group is done with it, and the slot belongs to a group that still needs an
 *   operator. A resolved episode whose issue is still unknown keeps its slot,
 *   because its delivery could not be established.
 */
export const MAX_ALERT_EPISODES_PER_SITE = 50;

/** The maximum number of occurrence keys one episode keeps. */
export const MAX_ALERT_EPISODE_OCCURRENCES = 100;

/** The severities, from the strongest to the weakest. */
const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** The validation states, from the strongest to the weakest. */
const VALIDATION_ORDER: readonly Validation[] = ['Confirmed', 'Likely', 'Indicator', 'Informational'];

/** The level of the eligible members of a group. */
export interface AlertLevel {
  severity: Severity;
  validation: Validation;
}

/** The rank of a severity. A stronger severity has a lower rank. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** The rank of a validation state. A stronger validation has a lower rank. */
export function validationRank(validation: Validation): number {
  return VALIDATION_ORDER.indexOf(validation);
}

/** Whether two strings differ by their code units. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * The key of one episode.
 *
 * The key mixes the issue key, the generation of the episode, the instant it
 * started and the identity of its first member. The member identity is a
 * keyed digest, so the key never leaks the hostname of the issue key and two
 * episodes of one issue key never share a key.
 */
export function episodeKey(
  issueKey: string,
  generation: number,
  createdAt: string,
  seed: string,
): string {
  return `ep-${digest(`episode:v1:${issueKey}|${generation}|${createdAt}|${seed}`)}`;
}

/** The fields of one episode. */
interface EpisodeFields {
  episodeKey: string;
  issueKey: string;
  state: 'open' | 'closed';
  occurrenceKeys: string[];
  lastChangedAt: string;
  issueState?: WebScanAlertEpisode['issueState'] | undefined;
  issueRequested?: boolean | undefined;
  resolved?: boolean | undefined;
  outcome?: WebScanAlertEpisode['outcome'] | undefined;
  severity?: Severity | undefined;
  validation?: Validation | undefined;
  generation?: number | undefined;
  createdAt?: string | undefined;
}

/**
 * Builds one episode.
 *
 * An absent optional field stays absent: the episode of a site that was
 * written before a field existed keeps the old meaning.
 */
export function episodeOf(fields: EpisodeFields): WebScanAlertEpisode {
  return {
    episodeKey: fields.episodeKey,
    issueKey: fields.issueKey,
    state: fields.state,
    occurrenceKeys: fields.occurrenceKeys,
    lastChangedAt: fields.lastChangedAt,
    ...(fields.issueState === undefined ? {} : { issueState: fields.issueState }),
    ...(fields.issueRequested === undefined ? {} : { issueRequested: fields.issueRequested }),
    ...(fields.resolved === undefined ? {} : { resolved: fields.resolved }),
    ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
    ...(fields.severity === undefined ? {} : { severity: fields.severity }),
    ...(fields.validation === undefined ? {} : { validation: fields.validation }),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    ...(fields.createdAt === undefined ? {} : { createdAt: fields.createdAt }),
  };
}

/** Keeps the last keys of a list when it outgrew its bound. */
function boundedKeys(keys: readonly string[]): string[] {
  if (keys.length <= MAX_ALERT_EPISODE_OCCURRENCES) {
    return [...keys];
  }
  return keys.slice(keys.length - MAX_ALERT_EPISODE_OCCURRENCES);
}

/**
 * The occurrence keys of an episode after new members joined it.
 *
 * The keys of the episode come first and the new ones are appended, so the
 * bound keeps the members that joined last.
 */
export function mergeOccurrenceKeys(
  previous: readonly string[],
  added: readonly string[],
): string[] {
  const merged = [...previous];
  const known = new Set(previous);
  for (const key of added) {
    if (!known.has(key)) {
      known.add(key);
      merged.push(key);
    }
  }
  return boundedKeys(merged);
}

/**
 * The order the episodes are evicted in.
 *
 * A resolved episode is evicted before an unresolved one, so the eviction never
 * drops the state of a group that still needs an operator. The oldest episode
 * goes first and the key of the episode breaks a tie, so the eviction is
 * deterministic and never depends on the order of the input.
 */
export function episodeEvictionOrder(
  left: WebScanAlertEpisode,
  right: WebScanAlertEpisode,
): number {
  const byResolved = Number(right.resolved === true) - Number(left.resolved === true);
  if (byResolved !== 0) {
    return byResolved;
  }
  const byAge = compareCodeUnits(left.lastChangedAt, right.lastChangedAt);
  if (byAge !== 0) {
    return byAge;
  }
  return compareCodeUnits(left.episodeKey, right.episodeKey);
}

/** One candidate episode of an evaluation. */
export interface AlertEpisodeCandidate {
  /** The episode the evaluation produced for the issue key. */
  episode: WebScanAlertEpisode;
  /**
   * Whether the issue key already carried an episode in the state of the site.
   *
   * An existing episode keeps its slot; a new one has to be admitted.
   */
  existing: boolean;
  /**
   * Whether this evaluation hands the episode an action to deliver.
   *
   * An episode with a delivery under way keeps its slot even when it is resolved:
   * the slot goes only once nothing is left to deliver for it, otherwise the action
   * would be dropped together with the episode. An over-bound state drops it after
   * every episode without a delivery, for the same reason.
   */
  pending?: boolean;
}

/**
 * Admits the candidate episodes of one evaluation into the bound.
 *
 * The returned episodes are the state to persist on the site row, ordered by
 * their issue key, so the persisted state never depends on the order of the
 * evaluation. A new candidate that the admission refuses leaves no episode and
 * no action behind: the group it belongs to is offered again on a later scan,
 * when a slot frees up.
 */
export function admitEpisodes(
  candidates: readonly AlertEpisodeCandidate[],
): WebScanAlertEpisode[] {
  const existing = candidates.filter((candidate) => candidate.existing);
  const waiting = candidates
    .filter((candidate) => !candidate.existing)
    .sort((left, right) => compareAdmissionOrder(left.episode, right.episode));

  const kept = capCandidates(existing);
  const admitted: AlertEpisodeCandidate[] = [];
  for (const candidate of waiting) {
    if (kept.length + admitted.length < MAX_ALERT_EPISODES_PER_SITE) {
      admitted.push(candidate);
      continue;
    }
    // The budget is full: a resolved episode releases its slot for the
    // candidate that waits for it.
    const released = releasedIndex(kept);
    if (released < 0) {
      break;
    }
    kept.splice(released, 1);
    admitted.push(candidate);
  }

  return [...kept, ...admitted]
    .map((candidate) => candidate.episode)
    .sort((left, right) => compareCodeUnits(left.issueKey, right.issueKey));
}

/**
 * Drops the candidates that do not fit the bound.
 *
 * A state that was written before the bound changed can hold more episodes
 * than the bound allows, so the excess is dropped with the eviction order: a
 * candidate with a delivery under way after every other one, so the action it
 * owes is never dropped together with it, and a resolved episode before an
 * unresolved one, so the eviction never drops the state of a group that still
 * needs an operator.
 */
function capCandidates(
  candidates: readonly AlertEpisodeCandidate[],
): AlertEpisodeCandidate[] {
  if (candidates.length <= MAX_ALERT_EPISODES_PER_SITE) {
    return [...candidates];
  }
  const evicted = new Set(
    [...candidates]
      .sort((left, right) => compareEvictionOrder(left, right))
      .slice(0, candidates.length - MAX_ALERT_EPISODES_PER_SITE)
      .map((candidate) => candidate.episode.episodeKey),
  );
  return candidates.filter((candidate) => !evicted.has(candidate.episode.episodeKey));
}

/**
 * Whether a candidate still owes something to an issue: a delivery under way, or a
 * resolved episode that has not settled yet (its comment is owed once its issue is
 * reported). Dropping it would lose that comment.
 */
function owesDelivery(candidate: AlertEpisodeCandidate): boolean {
  if (candidate.pending === true) return true;
  const episode = candidate.episode;
  return episode.resolved === true && !isSettled(episode);
}

/**
 * The order the candidates are dropped in.
 *
 * A candidate with a delivery under way is dropped after every other one: the
 * action it owes would be lost with it, so it keeps its slot as long as another
 * episode can go. The eviction order of the episodes decides then.
 */
function compareEvictionOrder(
  left: AlertEpisodeCandidate,
  right: AlertEpisodeCandidate,
): number {
  const byOwed = Number(owesDelivery(left)) - Number(owesDelivery(right));
  if (byOwed !== 0) {
    return byOwed;
  }
  return episodeEvictionOrder(left.episode, right.episode);
}

/**
 * Whether a resolved episode has nothing left to deliver, so its slot may go.
 *
 * An episode that resolved while a scheduled scan could not comment (a manual scan
 * marks it resolved and posts nothing) still owes its "fixed" or "resolved by
 * exception" comment while its issue exists, so it keeps its slot until the comment
 * is recorded; an unknown issue keeps it too. An episode without an issue owes nothing.
 */
function isSettled(episode: WebScanAlertEpisode): boolean {
  if (episode.resolved !== true || episode.issueState === 'unknown') return false;
  if (episode.outcome !== undefined) return true;
  if (episode.issueState === 'missing') return true;
  // An issue that was requested but not observed yet may already exist: the episode keeps
  // its slot until the caller reports what the issue is, or its comment would be lost.
  return episode.issueState === 'none' && episode.issueRequested !== true;
}

/**
 * The index of the resolved episode that the eviction order releases first.
 *
 * The oldest resolved episode goes first, and the key of the episode breaks a
 * tie, so the release never depends on the order of the evaluation.
 *
 * A resolved episode whose issue is still unknown keeps its slot: the
 * delivery could not be established, so the episode stays visibly unknown for
 * the operator instead of making room for another group.
 */
function releasedIndex(candidates: readonly AlertEpisodeCandidate[]): number {
  let index = -1;
  let chosen: WebScanAlertEpisode | undefined;
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    const episode = candidate?.episode;
    if (episode === undefined || candidate?.pending === true || !isSettled(episode)) {
      continue;
    }
    if (chosen === undefined || episodeEvictionOrder(episode, chosen) < 0) {
      chosen = episode;
      index = position;
    }
  }
  return index;
}

/**
 * The order the new candidates compete in.
 *
 * The strongest severity comes first, then the strongest validation, and the
 * issue key breaks the tie in the order of its code units, so the admission
 * never depends on the order of the evaluation.
 */
export function compareAdmissionOrder(
  left: WebScanAlertEpisode,
  right: WebScanAlertEpisode,
): number {
  const bySeverity = severityRank(left.severity ?? 'info') - severityRank(right.severity ?? 'info');
  if (bySeverity !== 0) {
    return bySeverity;
  }
  const byValidation =
    validationRank(left.validation ?? 'Informational') -
    validationRank(right.validation ?? 'Informational');
  if (byValidation !== 0) {
    return byValidation;
  }
  return compareCodeUnits(left.issueKey, right.issueKey);
}

/** Whether two episodes carry the same state, apart from their change stamp. */
export function sameEpisode(left: WebScanAlertEpisode, right: WebScanAlertEpisode): boolean {
  return (
    left.episodeKey === right.episodeKey &&
    left.issueKey === right.issueKey &&
    left.state === right.state &&
    left.issueState === right.issueState &&
    left.issueRequested === right.issueRequested &&
    left.resolved === right.resolved &&
    left.outcome === right.outcome &&
    left.severity === right.severity &&
    left.validation === right.validation &&
    left.generation === right.generation &&
    left.createdAt === right.createdAt &&
    left.occurrenceKeys.length === right.occurrenceKeys.length &&
    left.occurrenceKeys.every((key, index) => key === right.occurrenceKeys[index])
  );
}

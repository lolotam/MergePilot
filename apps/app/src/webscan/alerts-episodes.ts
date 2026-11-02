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

/** The maximum number of episodes one site keeps. */
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

/**
 * The bounded episode state of a site.
 *
 * The episodes are ordered by their issue key, so the persisted state never
 * depends on the order of the evaluation, and the episodes that do not fit the
 * bound are evicted with a deterministic rule.
 */
export function capEpisodes(episodes: readonly WebScanAlertEpisode[]): WebScanAlertEpisode[] {
  const ordered = [...episodes].sort((left, right) =>
    compareCodeUnits(left.issueKey, right.issueKey),
  );
  if (ordered.length <= MAX_ALERT_EPISODES_PER_SITE) {
    return ordered;
  }
  const evictedCount = ordered.length - MAX_ALERT_EPISODES_PER_SITE;
  const kept = new Set(
    [...ordered]
      .sort(episodeEvictionOrder)
      .slice(evictedCount)
      .map((episode) => episode.episodeKey),
  );
  return ordered.filter((episode) => kept.has(episode.episodeKey));
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

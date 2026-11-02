import type { GroupOccurrence, IssueGroup } from '@mergepilot/webscan';
import {
  admitEpisodes,
  compareAdmissionOrder,
  compareCodeUnits,
  episodeKey,
  episodeOf,
  mergeOccurrenceKeys,
  sameEpisode,
  type AlertLevel,
} from './alerts-episodes.js';
import {
  buildLedger,
  highestLevel,
  isEligible,
  levelOf,
  levelOfEpisode,
  levelRose,
  namedException,
  resolutionOf,
  sortedKeys,
} from './alerts-groups.js';
import { dashboardLink, deliveryMarker, severityCounts } from './alerts-payload.js';
import type {
  AlertAction,
  AlertEvaluation,
  AlertEvaluationInput,
  AlertExceptionCommentAction,
  AlertFixedCommentAction,
  AlertIssueState,
  AlertOpenIssueAction,
  AlertUnknownAction,
} from './alerts-types.js';
import type { WebScanAlertEpisode, WebScanException } from './types.js';

/**
 * The alert engine of the website scanner (ADR-0052 section 8).
 *
 * The engine turns the ledger of a completed scan into alert episodes and into
 * the actions the delivery layer has to perform. It is pure: it fetches no
 * issue, it writes no row, it reads no clock and it mutates nothing it is
 * given. The caller owns every side effect:
 *
 * - it observes the state of the referenced issue and hands it over;
 * - it delivers the actions and records their outcome;
 * - it persists the returned episode state under the lock of the site row.
 *
 * The rules it implements, in the words of ADR-0052 section 8:
 *
 * - An episode is started by the first eligibility of a group, by the
 *   re-eligibility of a group whose members were all excepted, by the
 *   recurrence of a group whose members were all proven fixed, or by a higher
 *   eligible severity or validation. A churn of targets, values or subjects
 *   joins the episode of its group and never opens a second issue.
 * - A manual scan updates the state and never consumes an unnotified episode.
 * - A scheduled scan opens at most one issue: the strongest group of the scan
 *   wins it, and the other groups keep their episode unnotified, so the next
 *   scheduled scan offers them again.
 * - An unknown state of the issue is never closed, never open and never
 *   advances the notification of the episode.
 * - The bounded episode state of a site is a budget of slots: an episode that
 *   the site already carries keeps its slot, and a new episode is admitted
 *   only while a slot is free.
 * - A confirmed missing issue keeps the episode eligible and is replaced by
 *   exactly one issue with the same deterministic marker.
 * - A "fixed" comment is reserved for a group whose members were all proven
 *   fixed. An administrator resolution is an accepted risk, so it gets its own
 *   "resolved by exception" comment and never a "fixed" one.
 */

/** The resolution of a group. */
type AlertResolution = 'fixed' | 'resolved-by-exception';

/** Everything one evaluation needs, resolved once. */
interface AlertContext {
  input: AlertEvaluationInput;
  groups: Map<string, IssueGroup>;
  exceptionsByOccurrence: Map<string, WebScanException>;
  observations: Map<string, AlertIssueState>;
  episodesByIssueKey: Map<string, WebScanAlertEpisode>;
  issueKeys: string[];
  dashboardUrl: string;
}

/** The result of the evaluation of one issue key. */
interface IssueKeyResult {
  episode: WebScanAlertEpisode;
  actions: AlertAction[];
}

/** One evaluated issue key of the site. */
interface EvaluatedEntry {
  /** The episode the evaluation produced and the actions it owes. */
  result: IssueKeyResult;
  /** Whether the issue key already carried an episode in the state of the site. */
  existing: boolean;
}

/**
 * Evaluates the alert state of a site.
 *
 * The returned episode state is the state to persist on the site row, bounded
 * and ordered by the issue key. The returned actions are the writes the
 * delivery layer has to perform; a manual scan never produces one.
 *
 * The bound is a budget of slots: the episodes the site already carries keep
 * their slot, and a new episode is admitted only while a slot is free. A new
 * episode that the admission refuses produces no action either, so the issue
 * of an episode whose state was never kept is never opened.
 *
 * A scheduled scan opens at most one issue. The limit is applied to the
 * episodes the admission kept, so the issue that opens always belongs to a
 * state that is persisted.
 */
export function evaluateAlertEpisodes(input: AlertEvaluationInput): AlertEvaluation {
  if (!input.thresholds.alertsEnabled) {
    return { episodes: [...input.episodes], actions: [] };
  }

  const context = buildContext(input);
  const evaluated: EvaluatedEntry[] = [];
  for (const issueKey of context.issueKeys) {
    const result = evaluateIssueKey(context, issueKey);
    if (result !== undefined) {
      evaluated.push({
        result,
        existing: context.episodesByIssueKey.has(result.episode.issueKey),
      });
    }
  }

  const admitted = admitEpisodes(
    evaluated.map((entry) => ({
      episode: entry.result.episode,
      existing: entry.existing,
      // Only a write that targets an issue that exists counts as a delivery under way. A
      // prospective open-issue targets no issue yet: it must not outrank an episode that
      // has a real issue behind it when an over-bound state is capped.
      pending: entry.result.actions.some((action) => action.kind !== 'open-issue'),
      hasIssue: hasIssueBehind(
        entry.result.episode,
        context.episodesByIssueKey.get(entry.result.episode.issueKey),
      ),
    })),
  );
  const admittedKeys = new Set(admitted.map((episode) => episode.episodeKey));

  // An episode that is not part of the persisted state leaves no action behind,
  // whether it is a new candidate the admission refused (its group is offered
  // again on a later scan) or an existing one an over-bound state dropped: an issue
  // opened for a state that is forgotten at once would be opened again later.
  const persisted = evaluated.filter((entry) => admittedKeys.has(entry.result.episode.episodeKey));

  // A scheduled scan opens one issue at most: the strongest group of the scan
  // wins it, and the other groups wait for the next one.
  const limited = limitOpenIssues(context, persisted);

  const actions: AlertAction[] = [];
  for (const entry of persisted) {
    actions.push(...(limited.get(entry.result.episode.episodeKey) ?? entry.result).actions);
  }
  const episodes = admitted.map((episode) => limited.get(episode.episodeKey)?.episode ?? episode);
  return { episodes, actions };
}

/**
 * Keeps one open issue per scheduled scan.
 *
 * A scheduled scan opens at most one issue (ADR-0052 section 8), so a scan with
 * many eligible groups never floods the repository: the strongest group wins the
 * scan, and the other ones keep their episode unnotified, so the next scheduled
 * scan offers them again.
 *
 * The winner is the strongest severity, then the strongest validation, then the
 * smallest issue key in the order of its code units: the order of the admission,
 * so the choice never depends on the order of the evaluation. A comment and a
 * mark of an unknown state are never limited: they report on an issue that is
 * already there.
 */
function limitOpenIssues(
  context: AlertContext,
  entries: readonly EvaluatedEntry[],
): Map<string, IssueKeyResult> {
  const results = new Map<string, IssueKeyResult>(
    entries.map((entry) => [entry.result.episode.episodeKey, entry.result]),
  );
  const requesting = entries.filter((entry) => opensIssue(entry.result));
  if (requesting.length <= 1) {
    return results;
  }
  const ordered = [...requesting].sort((left, right) =>
    compareAdmissionOrder(left.result.episode, right.result.episode),
  );
  const winner = ordered[0];
  if (winner === undefined) {
    return results;
  }
  for (const entry of requesting) {
    if (entry.result.episode.episodeKey === winner.result.episode.episodeKey) {
      continue;
    }
    results.set(entry.result.episode.episodeKey, withholdOpenIssue(context, entry.result));
  }
  return results;
}

/** Whether the evaluation hands the episode an action that opens its issue. */
function opensIssue(result: IssueKeyResult): boolean {
  return result.actions.some((action) => action.kind === 'open-issue');
}

/**
 * Withholds the open issue of one episode.
 *
 * The action is dropped and the episode never claims that its issue was
 * requested: a continued episode keeps the request and the issue state it had
 * before the evaluation, and a new episode starts without a request. The next
 * scheduled scan offers the group again.
 */
function withholdOpenIssue(context: AlertContext, result: IssueKeyResult): IssueKeyResult {
  const existing = context.episodesByIssueKey.get(result.episode.issueKey);
  const continued =
    existing !== undefined && existing.episodeKey === result.episode.episodeKey;
  const episode = episodeOf({
    episodeKey: result.episode.episodeKey,
    issueKey: result.episode.issueKey,
    state: result.episode.state,
    occurrenceKeys: result.episode.occurrenceKeys,
    lastChangedAt: result.episode.lastChangedAt,
    // The state observed in this scan is kept (a confirmed missing issue stays missing),
    // and nothing is claimed as requested: the next scan offers the issue again.
    issueState: continued ? (result.episode.issueState ?? 'none') : 'none',
    issueRequested: false,
    resolved: result.episode.resolved,
    outcome: result.episode.outcome,
    severity: result.episode.severity,
    validation: result.episode.validation,
    generation: result.episode.generation,
    createdAt: result.episode.createdAt,
  });
  return {
    episode,
    actions: result.actions.filter((action) => action.kind !== 'open-issue'),
  };
}

/**
 * Whether an issue is really behind an episode, for the cap of an over-bound state.
 *
 * An issue that was requested earlier, or that the caller observed, is behind it. A
 * confirmed missing issue is not, unless the replacement was requested after the
 * confirmation (the stored state was already missing and a request was recorded): that
 * replacement may exist. An issue this evaluation only proposes to open does not count.
 */
function hasIssueBehind(
  episode: WebScanAlertEpisode,
  previous: WebScanAlertEpisode | undefined,
): boolean {
  const state = episode.issueState ?? 'none';
  if (state === 'missing') {
    return previous?.issueState === 'missing' && previous.issueRequested === true;
  }
  return previous?.issueRequested === true || state !== 'none';
}

/** Resolves the input of one evaluation. */
function buildContext(input: AlertEvaluationInput): AlertContext {
  const nowMs = input.now.getTime();
  const ledger = buildLedger(input.occurrences, input.exceptions, nowMs);

  const observations = new Map<string, AlertIssueState>();
  for (const observation of input.issueStates ?? []) {
    observations.set(observation.episodeKey, observation.state);
  }

  const episodesByIssueKey = new Map<string, WebScanAlertEpisode>();
  for (const episode of input.episodes) {
    episodesByIssueKey.set(episode.issueKey, episode);
  }

  const issueKeys = new Set<string>([...ledger.groups.keys()]);
  for (const episode of input.episodes) {
    issueKeys.add(episode.issueKey);
  }

  return {
    input,
    groups: ledger.groups,
    exceptionsByOccurrence: ledger.exceptionsByOccurrence,
    observations,
    episodesByIssueKey,
    issueKeys: [...issueKeys].sort(compareCodeUnits),
    dashboardUrl: dashboardLink(input.dashboardBaseUrl, input.siteId),
  };
}

/** Evaluates one issue key of the site. */
function evaluateIssueKey(
  context: AlertContext,
  issueKey: string,
): IssueKeyResult | undefined {
  const group = context.groups.get(issueKey);
  const existing = context.episodesByIssueKey.get(issueKey);
  const members = group?.occurrences ?? [];
  const eligible = members.filter((member) => isEligible(member, context.input.thresholds));
  const level = levelOf(eligible);
  const resolution = resolutionOf(group, existing);

  if (existing === undefined) {
    if (eligible.length === 0) {
      return undefined;
    }
    return startEpisode(context, issueKey, 0, level, members, eligible);
  }

  const effective = effectiveIssueState(context, existing);
  // An unknown state of the issue is never closed and never open, so it never
  // starts a new episode: the issue of the episode may still exist, and the
  // episode continues, visibly unknown, until the state of the issue is known.
  if (effective !== 'unknown') {
    const recurred = existing.resolved === true && eligible.length > 0;
    if (recurred || (eligible.length > 0 && levelRose(existing, level))) {
      const generation = (existing.generation ?? 0) + 1;
      const inherited = highestLevel(level, levelOfEpisode(existing));
      return startEpisode(context, issueKey, generation, inherited, members, eligible);
    }
  }

  return continueEpisode(context, existing, members, eligible, resolution, effective);
}

/**
 * Starts a new episode of an issue key.
 *
 * The episode has no issue yet, so it asks for one. A manual scan starts the
 * episode but never asks for the issue: the episode stays unnotified and the
 * next scheduled scan delivers it.
 */
function startEpisode(
  context: AlertContext,
  issueKey: string,
  generation: number,
  level: AlertLevel,
  members: readonly GroupOccurrence[],
  eligible: readonly GroupOccurrence[],
): IssueKeyResult {
  const now = context.input.now.toISOString();
  const keys = sortedKeys(members);
  const scheduled = context.input.trigger === 'scheduled';
  const episode = episodeOf({
    episodeKey: episodeKey(issueKey, generation, now, keys[0] ?? issueKey),
    issueKey,
    state: 'open',
    occurrenceKeys: mergeOccurrenceKeys([], keys),
    lastChangedAt: now,
    issueState: 'none',
    issueRequested: scheduled,
    resolved: false,
    severity: level.severity,
    validation: level.validation,
    generation,
    createdAt: now,
  });
  const actions: AlertAction[] = scheduled ? [openIssueAction(context, episode, eligible)] : [];
  return { episode, actions };
}

/** Continues the episode of an issue key. */
function continueEpisode(
  context: AlertContext,
  existing: WebScanAlertEpisode,
  members: readonly GroupOccurrence[],
  eligible: readonly GroupOccurrence[],
  resolution: AlertResolution | undefined,
  effective: AlertIssueState,
): IssueKeyResult {
  const noIssue = effective === 'none' || effective === 'missing';
  const suppressed =
    existing.issueRequested === true && existing.issueState === effective && noIssue;
  const wantsIssue = eligible.length > 0 && noIssue && !suppressed;
  const scheduled = context.input.trigger === 'scheduled';

  const actions: AlertAction[] = [];
  if (wantsIssue && scheduled) {
    actions.push(openIssueAction(context, existing, eligible));
  }

  if (effective === 'unknown' && scheduled) {
    actions.push(unknownAction(existing));
  }

  let outcome = existing.outcome;
  const issueExists = effective === 'open' || effective === 'closed';
  if (resolution !== undefined && existing.outcome === undefined && issueExists && scheduled) {
    const comment = commentAction(context, existing, members, resolution);
    if (comment !== undefined) {
      actions.push(comment);
      outcome = resolution;
    }
  }

  const requestEmitted = actions.some((action) => action.kind === 'open-issue');
  const nextIssueRequested =
    requestEmitted || (existing.issueRequested === true && existing.issueState === effective);
  const candidate = episodeOf({
    episodeKey: existing.episodeKey,
    issueKey: existing.issueKey,
    state: effective === 'closed' ? 'closed' : 'open',
    occurrenceKeys: mergeOccurrenceKeys(existing.occurrenceKeys, sortedKeys(members)),
    lastChangedAt: context.input.now.toISOString(),
    issueState: effective,
    issueRequested: nextIssueRequested,
    resolved: existing.resolved === true || resolution !== undefined,
    outcome,
    severity: existing.severity,
    validation: existing.validation,
    generation: existing.generation,
    createdAt: existing.createdAt,
  });

  return {
    episode: sameEpisode(existing, candidate) ? existing : candidate,
    actions,
  };
}

/** The action that opens the issue of an episode. */
function openIssueAction(
  context: AlertContext,
  episode: WebScanAlertEpisode,
  eligible: readonly GroupOccurrence[],
): AlertOpenIssueAction {
  const marker = deliveryMarker(episode);
  return {
    kind: 'open-issue',
    episodeKey: episode.episodeKey,
    deliveryMarker: marker,
    issueMarker: marker,
    severityCounts: severityCounts(eligible.map((member) => member.severity)),
    dashboardUrl: context.dashboardUrl,
  };
}

/**
 * The action that marks the issue of an episode as unknown.
 *
 * The state of the issue could not be established, so the episode stays
 * visibly unknown for the operator instead of producing an issue every scan.
 */
function unknownAction(episode: WebScanAlertEpisode): AlertUnknownAction {
  return {
    kind: 'mark-unknown',
    episodeKey: episode.episodeKey,
    deliveryMarker: deliveryMarker(episode, 'mark-unknown'),
    issueMarker: deliveryMarker(episode),
  };
}

/**
 * The action that comments on the issue of a resolved group.
 *
 * A group that was proven fixed gets the "fixed" comment. A group that an
 * administrator resolved gets the "resolved by exception" comment, which names
 * the kind, the reason category and the expiry of the resolution.
 */
function commentAction(
  context: AlertContext,
  episode: WebScanAlertEpisode,
  members: readonly GroupOccurrence[],
  resolution: AlertResolution,
): AlertAction | undefined {
  if (resolution === 'fixed') {
    const fixed = members.filter((member) => member.state === 'fixed');
    const action: AlertFixedCommentAction = {
      kind: 'fixed-comment',
      episodeKey: episode.episodeKey,
      deliveryMarker: deliveryMarker(episode, 'fixed-comment'),
      issueMarker: deliveryMarker(episode),
      severityCounts: severityCounts(fixed.map((member) => member.severity)),
      dashboardUrl: context.dashboardUrl,
    };
    return action;
  }

  const resolved = members.filter(
    (member) => member.state === 'fixed' || member.exception !== undefined,
  );
  const exception = namedException(context.exceptionsByOccurrence, resolved);
  if (exception === undefined) {
    return undefined;
  }
  const action: AlertExceptionCommentAction = {
    kind: 'resolved-by-exception-comment',
    episodeKey: episode.episodeKey,
    deliveryMarker: deliveryMarker(episode, 'resolved-by-exception-comment'),
    issueMarker: deliveryMarker(episode),
    severityCounts: severityCounts(resolved.map((member) => member.severity)),
    dashboardUrl: context.dashboardUrl,
    exception: {
      kind: exception.kind,
      reasonCategory: exception.reasonCategory,
      expiresAt: exception.expiresAt === null ? null : exception.expiresAt.toISOString(),
    },
  };
  return action;
}

/**
 * The state of the issue of an episode.
 *
 * The observation of the caller wins. An episode that was written before the
 * observation existed carries the state of its issue, so it is a delivered
 * issue that is never reopened.
 */
function effectiveIssueState(
  context: AlertContext,
  episode: WebScanAlertEpisode,
): AlertIssueState {
  const observed = context.observations.get(episode.episodeKey);
  if (observed !== undefined) {
    return observed;
  }
  if (episode.issueState !== undefined) {
    return episode.issueState;
  }
  return episode.state === 'closed' ? 'closed' : 'open';
}

export {
  MAX_ALERT_EPISODES_PER_SITE,
  MAX_ALERT_EPISODE_OCCURRENCES,
} from './alerts-episodes.js';
export {
  deliveryMarker,
  renderExceptionCommentBody,
  renderFixedCommentBody,
  renderIssueBody,
} from './alerts-payload.js';
export type * from './alerts-types.js';

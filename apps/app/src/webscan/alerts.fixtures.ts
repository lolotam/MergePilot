import type { OccurrenceFinding, RetainedOccurrence } from '@mergepilot/webscan';
import { evaluateAlertEpisodes } from './alerts.js';
import type {
  AlertAction,
  AlertEvaluation,
  AlertIssueState,
  AlertOpenIssueAction,
  AlertThresholds,
} from './alerts-types.js';
import type { WebScanAlertEpisode, WebScanException } from './types.js';

/**
 * The fixtures of the alert engine (ADR-0052 section 8).
 *
 * The scenario runner simulates several consecutive scans: it feeds the episode
 * state of one evaluation into the next one, so a test can read the lifecycle
 * of a group the way the worker sees it.
 */

/** The issue key of the fixture group. */
export const ISSUE_KEY = 'headers:missing-hsts:example.test';

/** The instant the fixtures use. */
export const NOW = new Date('2026-02-01T00:00:00.000Z');

/** The site the fixtures use. */
export const SITE_ID = 'site-1';

/** The base URL of the dashboard the fixtures use. */
export const DASHBOARD_BASE_URL = 'https://dashboard.test';

/** The default thresholds of the fixtures. */
export const THRESHOLDS: AlertThresholds = {
  alertsEnabled: true,
  alertMinSeverity: 'high',
  alertMinValidation: 'Likely',
};

/** The instant of the nth day of the fixture month. */
export function day(index: number): Date {
  return new Date(NOW.getTime() + index * 24 * 60 * 60 * 1000);
}

/** One finding of the fixture ledger. */
export function finding(overrides: Partial<OccurrenceFinding> = {}): OccurrenceFinding {
  return {
    occurrenceKey: 'occurrence-1',
    targetKey: 'target-1',
    checkId: 'headers',
    checkVersion: 1,
    issueKey: ISSUE_KEY,
    issueId: 'missing-hsts',
    subject: 'hsts',
    severity: 'high',
    validation: 'Confirmed',
    confidence: 'high',
    safeLocation: '/admin',
    evidenceHash: 'evidence-hash-1',
    evidence: { header: 'strict-transport-security' },
    ...overrides,
  };
}

/** One outstanding member of the fixture group. */
export function outstanding(overrides: Partial<OccurrenceFinding> = {}): RetainedOccurrence {
  return { finding: finding(overrides), state: 'outstanding' };
}

/** One member of the fixture group that was proven fixed. */
export function provenFixed(overrides: Partial<OccurrenceFinding> = {}): RetainedOccurrence {
  return { finding: finding(overrides), state: 'fixed' };
}

/** One archived member of the fixture group that was never proven fixed. */
export function archived(overrides: Partial<OccurrenceFinding> = {}): RetainedOccurrence {
  const { evidence: _evidence, ...identity } = finding(overrides);
  return { identity, state: 'archived', archiveReason: 'unobserved_retention' };
}

/** One administrator resolution of the fixture group. */
export function resolution(overrides: Partial<WebScanException> = {}): WebScanException {
  return {
    id: 'exception-1',
    siteId: SITE_ID,
    occurrenceKey: 'occurrence-1',
    evidenceHash: 'evidence-hash-1',
    kind: 'accepted',
    reasonCategory: 'accepted_risk',
    reason: 'the host is behind a load balancer that adds the header',
    expiresAt: null,
    createdBy: 'admin-1',
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

/** One step of a scenario. */
export interface ScenarioStep {
  trigger: 'scheduled' | 'manual';
  at: Date;
  occurrences: readonly RetainedOccurrence[];
  exceptions?: readonly WebScanException[];
  /** The observed state of the issue of a group, named by its issue key. */
  issueStates?: readonly { issueKey: string; state: AlertIssueState }[];
}

/** The result of a scenario. */
export interface ScenarioResult {
  /** The evaluation of every step. */
  evaluations: AlertEvaluation[];
  /** The actions of every step. */
  actions: AlertAction[][];
  /** The episode state after the last step. */
  episodes: WebScanAlertEpisode[];
}

/** The episode key of one issue key, when the site has such an episode. */
function episodeKeyOf(
  episodes: readonly WebScanAlertEpisode[],
  issueKey: string,
): string {
  return episodes.find((episode) => episode.issueKey === issueKey)?.episodeKey ?? '';
}

/** The actions of one kind. */
export function actionsOfKind<K extends AlertAction['kind']>(
  actions: readonly AlertAction[],
  kind: K,
): Extract<AlertAction, { kind: K }>[] {
  return actions.filter(
    (action): action is Extract<AlertAction, { kind: K }> => action.kind === kind,
  );
}

/** The action that opens the issue of an episode, when there is one. */
export function openIssueAction(
  actions: readonly AlertAction[],
): AlertOpenIssueAction | undefined {
  const action = actions.find((candidate) => candidate.kind === 'open-issue');
  return action?.kind === 'open-issue' ? action : undefined;
}

/**
 * Runs several consecutive scans.
 *
 * The episode state of an evaluation is the episode state of the next one, so
 * the scenario reads the lifecycle of a group exactly the way the worker sees
 * it after every completed scan.
 */
export function runAlertScenario(
  steps: readonly ScenarioStep[],
  options: { thresholds?: Partial<AlertThresholds> } = {},
): ScenarioResult {
  const thresholds: AlertThresholds = { ...THRESHOLDS, ...options.thresholds };
  let episodes: WebScanAlertEpisode[] = [];
  const evaluations: AlertEvaluation[] = [];

  for (const step of steps) {
    const issueStates = (step.issueStates ?? []).map((observation) => ({
      episodeKey: episodeKeyOf(episodes, observation.issueKey),
      state: observation.state,
    }));
    const evaluation = evaluateAlertEpisodes({
      trigger: step.trigger,
      now: step.at,
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds,
      episodes,
      occurrences: step.occurrences,
      exceptions: step.exceptions ?? [],
      issueStates,
    });
    evaluations.push(evaluation);
    episodes = evaluation.episodes;
  }

  return {
    evaluations,
    actions: evaluations.map((evaluation) => evaluation.actions),
    episodes,
  };
}

import { describe, expect, it } from 'vitest';
import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import { actionsOfKind, day, outstanding, runAlertScenario } from './alerts.fixtures.js';

/**
 * The single issue of a scheduled scan (ADR-0052 section 8).
 *
 * A scheduled scan opens at most one issue, so a scan with many eligible groups
 * never floods the repository: the strongest group of the scan wins it, and the
 * other groups keep their episode unnotified, so the next scheduled scan offers
 * them again.
 */

/** The thresholds that let every group of the fixtures open an issue. */
const EVERY_GROUP = { alertMinSeverity: 'low', alertMinValidation: 'Informational' } as const;

/** The issue key of the nth group of the fixture site. */
function issueKeyOf(index: number): string {
  return `headers:missing-hsts:host-${String(index).padStart(2, '0')}.test`;
}

/** The occurrence key of the nth group of the fixture site. */
function occurrenceKeyOf(index: number): string {
  return `occurrence-${String(index).padStart(2, '0')}`;
}

/** One outstanding group of the fixture site. */
function group(
  index: number,
  severity: Severity,
  validation: Validation,
): RetainedOccurrence {
  return outstanding({
    occurrenceKey: occurrenceKeyOf(index),
    targetKey: `target-${String(index).padStart(2, '0')}`,
    issueKey: issueKeyOf(index),
    severity,
    validation,
  });
}

/** The three groups of the fixture site, the strongest one last. */
function threeGroups(): RetainedOccurrence[] {
  return [
    group(0, 'medium', 'Confirmed'),
    group(1, 'high', 'Confirmed'),
    group(2, 'critical', 'Likely'),
  ];
}

/** The issue key of the episode an opened issue belongs to. */
function openedIssueKey(
  episodes: readonly { episodeKey: string; issueKey: string }[],
  episodeKey: string | undefined,
): string | undefined {
  return episodes.find((episode) => episode.episodeKey === episodeKey)?.issueKey;
}

/** The issue keys of the episodes that wait for their issue. */
function waitingIssueKeys(
  episodes: readonly { issueKey: string; issueRequested?: boolean }[],
): string[] {
  return episodes
    .filter((episode) => episode.issueRequested !== true)
    .map((episode) => episode.issueKey)
    .sort();
}

describe('the single issue of a scheduled scan of the website scanner', () => {
  it('opens the issue of the strongest group and keeps the other groups unnotified', () => {
    const scenario = runAlertScenario(
      [{ trigger: 'scheduled', at: day(1), occurrences: threeGroups() }],
      { thresholds: EVERY_GROUP },
    );

    const opened = actionsOfKind(scenario.actions[0] ?? [], 'open-issue');

    expect(opened).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, opened[0]?.episodeKey)).toBe(issueKeyOf(2));
    // The two other groups keep their episode, unnotified: the next scan offers them.
    expect(scenario.episodes).toHaveLength(3);
    expect(waitingIssueKeys(scenario.episodes)).toEqual([issueKeyOf(0), issueKeyOf(1)]);
  });

  it('opens the next group of the scan on the next scheduled scan', () => {
    const occurrences = threeGroups();
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences },
        { trigger: 'scheduled', at: day(2), occurrences },
      ],
      { thresholds: EVERY_GROUP },
    );

    const first = actionsOfKind(scenario.actions[0] ?? [], 'open-issue');
    const second = actionsOfKind(scenario.actions[1] ?? [], 'open-issue');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, first[0]?.episodeKey)).toBe(issueKeyOf(2));
    expect(openedIssueKey(scenario.episodes, second[0]?.episodeKey)).toBe(issueKeyOf(1));
  });

  it('opens nothing more when every group of the scan is notified', () => {
    const occurrences = threeGroups();
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences },
        { trigger: 'scheduled', at: day(2), occurrences },
        { trigger: 'scheduled', at: day(3), occurrences },
        { trigger: 'scheduled', at: day(4), occurrences },
      ],
      { thresholds: EVERY_GROUP },
    );

    expect(actionsOfKind(scenario.actions[0] ?? [], 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(1);
    // Every group is notified: the scan opens nothing more.
    expect(actionsOfKind(scenario.actions[3] ?? [], 'open-issue')).toHaveLength(0);
    expect(scenario.episodes.every((episode) => episode.issueRequested === true)).toBe(true);
  });

  it('opens one issue when a confirmed missing issue and a new group want one', () => {
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: [group(0, 'high', 'Confirmed')] },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [group(0, 'high', 'Confirmed'), group(1, 'critical', 'Confirmed')],
          issueStates: [{ issueKey: issueKeyOf(0), state: 'missing' }],
        },
        {
          trigger: 'scheduled',
          at: day(3),
          occurrences: [group(0, 'high', 'Confirmed'), group(1, 'critical', 'Confirmed')],
          issueStates: [{ issueKey: issueKeyOf(0), state: 'missing' }],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const second = actionsOfKind(scenario.actions[1] ?? [], 'open-issue');
    const third = actionsOfKind(scenario.actions[2] ?? [], 'open-issue');

    // The replacement and the first issue compete for the one issue of the scan:
    // the stronger group wins it.
    expect(second).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, second[0]?.episodeKey)).toBe(issueKeyOf(1));
    // The replacement waits for a later scan: its episode never claimed it.
    expect(third).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, third[0]?.episodeKey)).toBe(issueKeyOf(0));
  });
});

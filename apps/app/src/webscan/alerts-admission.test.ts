import { describe, expect, it } from 'vitest';
import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import { MAX_ALERT_EPISODES_PER_SITE } from './alerts-episodes.js';
import { evaluateAlertEpisodes } from './alerts.js';
import {
  actionsOfKind,
  DASHBOARD_BASE_URL,
  day,
  outstanding,
  provenFixed,
  runAlertScenario,
  SITE_ID,
  THRESHOLDS,
} from './alerts.fixtures.js';
import type { WebScanAlertEpisode } from './types.js';

/**
 * The admission of the episodes of a site (ADR-0052 section 8).
 *
 * The bound of the episode state is a budget of slots: the episodes a site
 * already carries keep their slot, and a new episode is admitted only while a
 * slot is free. A group that is not admitted opens no issue, so its episode
 * never rotates and never opens a second issue.
 */

/** The thresholds that let every group of the fixtures open an issue. */
const EVERY_GROUP = { alertMinSeverity: 'low', alertMinValidation: 'Informational' } as const;

/** The level of one group of the fixture site. */
interface GroupLevel {
  severity: Severity;
  validation: Validation;
}

/** The issue key of the nth group of the fixture site. */
function issueKeyOf(index: number): string {
  return `headers:missing-hsts:host-${String(index).padStart(2, '0')}.test`;
}

/** The occurrence key of the nth group of the fixture site. */
function occurrenceKeyOf(index: number): string {
  return `occurrence-${String(index).padStart(2, '0')}`;
}

/** One outstanding group of the fixture site. */
function group(index: number, level: GroupLevel): RetainedOccurrence {
  return outstanding({
    occurrenceKey: occurrenceKeyOf(index),
    targetKey: `target-${String(index).padStart(2, '0')}`,
    issueKey: issueKeyOf(index),
    severity: level.severity,
    validation: level.validation,
  });
}

/** The group of the fixture site that was proven fixed. */
function fixedGroup(index: number, level: GroupLevel): RetainedOccurrence {
  return provenFixed({
    occurrenceKey: occurrenceKeyOf(index),
    targetKey: `target-${String(index).padStart(2, '0')}`,
    issueKey: issueKeyOf(index),
    severity: level.severity,
    validation: level.validation,
  });
}

/** The groups of a site that has more eligible groups than the bound. */
function crowdedGroups(): RetainedOccurrence[] {
  return [
    ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
      group(index, { severity: 'high', validation: 'Confirmed' }),
    ),
    group(MAX_ALERT_EPISODES_PER_SITE, { severity: 'medium', validation: 'Confirmed' }),
    group(MAX_ALERT_EPISODES_PER_SITE + 1, { severity: 'medium', validation: 'Confirmed' }),
  ];
}

/** The issue keys of the episodes the site carries. */
function admittedKeys(episodes: readonly { issueKey: string }[]): Set<string> {
  return new Set(episodes.map((episode) => episode.issueKey));
}

/** One episode of a state that was written before the bound changed. */
function carriedEpisode(index: number): WebScanAlertEpisode {
  return {
    episodeKey: `ep-${index}`,
    issueKey: issueKeyOf(index),
    state: 'open',
    occurrenceKeys: [occurrenceKeyOf(index)],
    lastChangedAt: day(1).toISOString(),
    issueState: 'open',
    issueRequested: true,
    resolved: false,
    severity: 'high',
    validation: 'Confirmed',
    generation: 0,
    createdAt: day(1).toISOString(),
  };
}

/** The issue key of the episode an opened issue belongs to. */
function openedIssueKey(
  episodes: readonly { episodeKey: string; issueKey: string }[],
  episodeKey: string | undefined,
): string | undefined {
  return episodes.find((episode) => episode.episodeKey === episodeKey)?.issueKey;
}

describe('the admission of the episodes of the website scanner', () => {
  it('admits the strongest groups of a site and opens no issue for the groups it refuses', () => {
    const scenario = runAlertScenario(
      [{ trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() }],
      { thresholds: EVERY_GROUP },
    );

    const opened = actionsOfKind(scenario.actions[0] ?? [], 'open-issue');
    const admitted = admittedKeys(scenario.episodes);
    const episodeKeys = new Set(scenario.episodes.map((episode) => episode.episodeKey));

    expect(scenario.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // A scheduled scan opens one issue: the strongest group of the scan.
    expect(opened).toHaveLength(1);
    expect(opened.every((action) => episodeKeys.has(action.episodeKey))).toBe(true);
    expect(openedIssueKey(scenario.episodes, opened[0]?.episodeKey)).toBe(issueKeyOf(0));
    expect(admitted.has(issueKeyOf(0))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE + 1))).toBe(false);
  });

  it('opens one issue per scan for the groups of a site that grew past the bound', () => {
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        { trigger: 'scheduled', at: day(2), occurrences: crowdedGroups() },
      ],
      { thresholds: EVERY_GROUP },
    );

    const first = actionsOfKind(scenario.actions[0] ?? [], 'open-issue');
    const second = actionsOfKind(scenario.actions[1] ?? [], 'open-issue');

    // The scan opens one issue, and the next scan opens the next group, the
    // strongest one first.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, first[0]?.episodeKey)).toBe(issueKeyOf(0));
    expect(openedIssueKey(scenario.episodes, second[0]?.episodeKey)).toBe(issueKeyOf(1));
    expect(scenario.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(admittedKeys(scenario.episodes).has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(
      false,
    );
    expect(admittedKeys(scenario.episodes).has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE + 1))).toBe(
      false,
    );
  });

  it('admits exactly one of the waiting groups when a group of the site is resolved', () => {
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [
            fixedGroup(0, { severity: 'high', validation: 'Confirmed' }),
            ...crowdedGroups().slice(1),
          ],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const admitted = admittedKeys(scenario.episodes);

    // The scan opened the issue of the strongest group that waited for one, so
    // the group that entered the state waits for a later scan.
    const opened = actionsOfKind(scenario.actions[1] ?? [], 'open-issue');
    expect(opened).toHaveLength(1);
    expect(openedIssueKey(scenario.episodes, opened[0]?.episodeKey)).toBe(issueKeyOf(1));
    const waiting = scenario.episodes.find(
      (episode) => episode.issueKey === issueKeyOf(MAX_ALERT_EPISODES_PER_SITE),
    );
    expect(waiting?.issueRequested).toBe(false);
    expect(scenario.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(admitted.has(issueKeyOf(0))).toBe(false);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE + 1))).toBe(false);
  });

  it('prefers the group with the stronger severity when two groups wait for one slot', () => {
    const scenario = runAlertScenario(
      [
        {
          trigger: 'scheduled',
          at: day(1),
          occurrences: [
            ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
              group(index, { severity: 'medium', validation: 'Confirmed' }),
            ),
            group(MAX_ALERT_EPISODES_PER_SITE, { severity: 'high', validation: 'Confirmed' }),
          ],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const admitted = admittedKeys(scenario.episodes);

    // The stronger group waits behind every weaker one, so only the strength
    // of its level can put it into the state.
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE - 1))).toBe(false);
  });

  it('prefers the group with the stronger validation when two groups wait for one slot', () => {
    const scenario = runAlertScenario(
      [
        {
          trigger: 'scheduled',
          at: day(1),
          occurrences: [
            ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE - 1 }, (_value, index) =>
              group(index, { severity: 'medium', validation: 'Confirmed' }),
            ),
            group(MAX_ALERT_EPISODES_PER_SITE - 1, { severity: 'medium', validation: 'Likely' }),
            group(MAX_ALERT_EPISODES_PER_SITE, { severity: 'medium', validation: 'Likely' }),
            group(MAX_ALERT_EPISODES_PER_SITE + 1, { severity: 'medium', validation: 'Confirmed' }),
          ],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const admitted = admittedKeys(scenario.episodes);

    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE + 1))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
  });

  it('keeps the slot of a resolved episode whose issue is still unknown', () => {
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [
            fixedGroup(0, { severity: 'high', validation: 'Confirmed' }),
            ...crowdedGroups().slice(1),
          ],
          issueStates: [{ issueKey: issueKeyOf(0), state: 'unknown' }],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const admitted = admittedKeys(scenario.episodes);

    // The episode whose issue is unknown keeps its slot, so no group enters the
    // state: the scan opens the issue of the strongest group that waits for one.
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(admitted.has(issueKeyOf(0))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
  });

  it('keeps the slot of an episode a manual scan resolved until its comment is recorded', () => {
    const resolvedGroup = fixedGroup(0, { severity: 'high', validation: 'Confirmed' });
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: crowdedGroups(),
          issueStates: [{ issueKey: issueKeyOf(0), state: 'open' }],
        },
        // The manual scan sees the group fixed but delivers nothing: the comment is still owed.
        {
          trigger: 'manual',
          at: day(3),
          occurrences: [resolvedGroup, ...crowdedGroups().slice(1)],
          issueStates: [{ issueKey: issueKeyOf(0), state: 'open' }],
        },
        {
          trigger: 'scheduled',
          at: day(4),
          occurrences: [resolvedGroup, ...crowdedGroups().slice(1)],
          issueStates: [{ issueKey: issueKeyOf(0), state: 'open' }],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    // After the manual scan the resolved episode still holds its slot.
    const afterManual = scenario.evaluations[2]?.episodes ?? [];
    expect(admittedKeys(afterManual).has(issueKeyOf(0))).toBe(true);
    expect(admittedKeys(afterManual).has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);

    // The next scheduled scan delivers the comment that was owed.
    expect(actionsOfKind(scenario.actions[3] ?? [], 'fixed-comment')).toHaveLength(1);
  });

  it('opens no issue for an existing episode that a state beyond the bound drops', () => {
    // A state written before the bound existed: one episode more than a site may keep, none notified.
    const seeded = runAlertScenario(
      [
        {
          trigger: 'manual',
          at: day(1),
          occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
            group(index, { severity: 'high', validation: 'Confirmed' }),
          ),
        },
      ],
      { thresholds: EVERY_GROUP },
    );
    const template = seeded.episodes[0];
    if (template === undefined) throw new Error('the seed holds no episode');
    const extraIndex = MAX_ALERT_EPISODES_PER_SITE;
    const overBound = [
      ...seeded.episodes,
      {
        ...template,
        episodeKey: `extra-episode-${extraIndex}`,
        issueKey: issueKeyOf(extraIndex),
        severity: 'info' as const,
      },
    ];

    const evaluation = evaluateAlertEpisodes({
      trigger: 'scheduled',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: overBound,
      occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
        group(index, { severity: 'high', validation: 'Confirmed' }),
      ),
      exceptions: [],
      issueStates: [],
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // Every action belongs to an episode that is persisted: nothing is opened and then forgotten.
    expect(evaluation.actions.every((action) => keptKeys.has(action.episodeKey))).toBe(true);
    expect(keptKeys.has(`extra-episode-${extraIndex}`)).toBe(false);
    // The scan opens one issue, and it opens the issue of an episode the state keeps.
    const opened = actionsOfKind(evaluation.actions, 'open-issue');
    expect(opened).toHaveLength(1);
    expect(keptKeys.has(opened[0]?.episodeKey ?? '')).toBe(true);
  });

  it('refuses the group with the last issue key when the groups are of the same level', () => {
    const scenario = runAlertScenario(
      [
        {
          trigger: 'scheduled',
          at: day(1),
          occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
            group(index, { severity: 'high', validation: 'Confirmed' }),
          ),
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    const admitted = admittedKeys(scenario.episodes);

    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE - 1))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
  });

  it('keeps the episode whose comment is owed and drops another one instead', () => {
    // A state written before the bound existed: one episode more than a site may keep.
    const episodes = Array.from(
      { length: MAX_ALERT_EPISODES_PER_SITE + 1 },
      (_value, index) => carriedEpisode(index),
    );

    const evaluation = evaluateAlertEpisodes({
      trigger: 'scheduled',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes,
      occurrences: [
        fixedGroup(0, { severity: 'high', validation: 'Confirmed' }),
        ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
          group(index + 1, { severity: 'high', validation: 'Confirmed' }),
        ),
      ],
      exceptions: [],
      issueStates: [],
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // The episode that owes a comment keeps its slot: another episode goes.
    expect(keptKeys.has('ep-0')).toBe(true);
    expect(keptKeys.has('ep-1')).toBe(false);
    // The comment is offered, because the episode it belongs to is still there.
    expect(actionsOfKind(evaluation.actions, 'fixed-comment')).toHaveLength(1);
  });
});

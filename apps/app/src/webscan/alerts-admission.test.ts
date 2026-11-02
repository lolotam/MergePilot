import { describe, expect, it } from 'vitest';
import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import { MAX_ALERT_EPISODES_PER_SITE } from './alerts-episodes.js';
import {
  actionsOfKind,
  day,
  outstanding,
  provenFixed,
  runAlertScenario,
} from './alerts.fixtures.js';

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
    expect(opened).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(opened.every((action) => episodeKeys.has(action.episodeKey))).toBe(true);
    expect(admitted.has(issueKeyOf(0))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE + 1))).toBe(false);
  });

  it('opens no issue again for the groups of a site that grew past the bound', () => {
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        { trigger: 'scheduled', at: day(2), occurrences: crowdedGroups() },
      ],
      { thresholds: EVERY_GROUP },
    );

    expect(actionsOfKind(scenario.actions[0] ?? [], 'open-issue')).toHaveLength(
      MAX_ALERT_EPISODES_PER_SITE,
    );
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(0);
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

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
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

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(0);
    expect(scenario.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(admitted.has(issueKeyOf(0))).toBe(true);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(false);
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
});

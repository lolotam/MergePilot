import { describe, expect, it } from 'vitest';
import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import { MAX_ALERT_EPISODES_PER_SITE } from './alerts-episodes.js';
import { evaluateAlertEpisodes } from './alerts.js';
import {
  DASHBOARD_BASE_URL,
  day,
  outstanding,
  provenFixed,
  runAlertScenario,
  SITE_ID,
  THRESHOLDS,
} from './alerts.fixtures.js';

/**
 * How a resolved episode releases its slot (ADR-0052 section 8).
 *
 * A resolved episode whose issue was requested keeps its slot until the caller reports
 * what that issue is, and it is not the first one to go when a state is capped.
 */

/** The thresholds that let every group of the fixtures open an issue. */
const EVERY_GROUP = { alertMinSeverity: 'low', alertMinValidation: 'Informational' } as const;

interface GroupLevel {
  severity: Severity;
  validation: Validation;
}

function issueKeyOf(index: number): string {
  return `headers:missing-hsts:host-${String(index).padStart(2, '0')}.test`;
}

function occurrenceFields(index: number, level: GroupLevel) {
  return {
    occurrenceKey: `occurrence-${String(index).padStart(2, '0')}`,
    targetKey: `target-${String(index).padStart(2, '0')}`,
    issueKey: issueKeyOf(index),
    severity: level.severity,
    validation: level.validation,
  };
}

function group(index: number, level: GroupLevel): RetainedOccurrence {
  return outstanding(occurrenceFields(index, level));
}

function fixedGroup(index: number, level: GroupLevel): RetainedOccurrence {
  return provenFixed(occurrenceFields(index, level));
}

function crowdedGroups(): RetainedOccurrence[] {
  return [
    ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
      group(index, { severity: 'high', validation: 'Confirmed' }),
    ),
    group(MAX_ALERT_EPISODES_PER_SITE, { severity: 'medium', validation: 'Confirmed' }),
    group(MAX_ALERT_EPISODES_PER_SITE + 1, { severity: 'medium', validation: 'Confirmed' }),
  ];
}

function admittedKeys(episodes: readonly { issueKey: string }[]): Set<string> {
  return new Set(episodes.map((episode) => episode.issueKey));
}

describe('the release of the slot of a resolved episode', () => {
  it('frees the slot of a resolved episode once its requested issue is reported missing', () => {
    const afterResolution = [
      fixedGroup(0, { severity: 'high', validation: 'Confirmed' }),
      ...crowdedGroups().slice(1),
    ];
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences: crowdedGroups() },
        { trigger: 'scheduled', at: day(2), occurrences: afterResolution },
        // The delivery layer reports that the requested issue does not exist (it was refused).
        {
          trigger: 'scheduled',
          at: day(3),
          occurrences: afterResolution,
          issueStates: [{ issueKey: issueKeyOf(0), state: 'missing' }],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    // Still held while nothing is reported, freed once the issue is reported missing.
    expect(admittedKeys(scenario.evaluations[1]?.episodes ?? []).has(issueKeyOf(0))).toBe(true);
    const admitted = admittedKeys(scenario.episodes);
    expect(admitted.has(issueKeyOf(0))).toBe(false);
    expect(admitted.has(issueKeyOf(MAX_ALERT_EPISODES_PER_SITE))).toBe(true);
  });

  it('does not drop a resolved episode that owes a comment when a state beyond the bound is capped', () => {
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
    // One episode resolved after its issue was requested but before it was observed.
    const owing = {
      ...template,
      resolved: true,
      issueState: 'none' as const,
      issueRequested: true,
    };
    const extraIndex = MAX_ALERT_EPISODES_PER_SITE;
    const overBound = [
      owing,
      ...seeded.episodes.slice(1),
      {
        ...template,
        episodeKey: `extra-episode-${extraIndex}`,
        issueKey: issueKeyOf(extraIndex),
        resolved: false,
      },
    ];

    const evaluation = evaluateAlertEpisodes({
      trigger: 'scheduled',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: overBound,
      occurrences: [
        fixedGroup(0, { severity: 'high', validation: 'Confirmed' }),
        ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
          group(index + 1, { severity: 'high', validation: 'Confirmed' }),
        ).slice(0, MAX_ALERT_EPISODES_PER_SITE - 1),
      ],
      exceptions: [],
      issueStates: [],
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(keptKeys.has(owing.episodeKey)).toBe(true);
  });


  it('keeps an episode whose replacement of a missing issue was requested', () => {
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
    const withIssue = seeded.episodes.slice(1).map((episode) => ({
      ...episode,
      issueState: 'open' as const,
      issueRequested: true,
    }));
    // The issue was confirmed missing and its replacement requested; nothing is reported
    // about it since, so the replacement may exist. Its key sorts first among equals.
    const replacing = {
      ...template,
      episodeKey: 'a-replacement-requested',
      issueState: 'missing' as const,
      issueRequested: true,
    };
    const withoutIssue = {
      ...template,
      episodeKey: 'z-without-issue',
      issueKey: issueKeyOf(MAX_ALERT_EPISODES_PER_SITE),
      issueState: 'none' as const,
      issueRequested: false,
    };

    const evaluation = evaluateAlertEpisodes({
      trigger: 'manual',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: [replacing, ...withIssue, withoutIssue],
      occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
        group(index, { severity: 'high', validation: 'Confirmed' }),
      ),
      exceptions: [],
      issueStates: withIssue.map((episode) => ({ episodeKey: episode.episodeKey, state: 'open' as const })),
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(keptKeys.has('a-replacement-requested')).toBe(true);
    expect(keptKeys.has('z-without-issue')).toBe(false);
  });

  it('keeps a requested replacement even when it is reported missing again', () => {
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
    const withIssue = seeded.episodes.slice(1).map((episode) => ({
      ...episode,
      issueState: 'open' as const,
      issueRequested: true,
    }));
    // Stored as missing with a replacement requested; the caller reports it missing again. It was
    // requested exactly once and may exist, so it keeps its protection. Its key sorts last among
    // equals, so only the rank (not the tie-break) can decide.
    const replacing = {
      ...template,
      episodeKey: 'z-replacement-requested',
      issueState: 'missing' as const,
      issueRequested: true,
    };
    const other = {
      ...template,
      episodeKey: '0-other',
      issueKey: issueKeyOf(MAX_ALERT_EPISODES_PER_SITE),
      // The member of its own group, so the evaluation leaves the episode unchanged (same age).
      occurrenceKeys: [`occurrence-${String(MAX_ALERT_EPISODES_PER_SITE).padStart(2, '0')}`],
      issueState: 'open' as const,
      issueRequested: true,
    };

    const evaluation = evaluateAlertEpisodes({
      trigger: 'manual',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: [replacing, ...withIssue, other],
      occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
        group(index, { severity: 'high', validation: 'Confirmed' }),
      ),
      exceptions: [],
      issueStates: [
        ...withIssue.map((episode) => ({ episodeKey: episode.episodeKey, state: 'open' as const })),
        { episodeKey: other.episodeKey, state: 'open' as const },
        { episodeKey: replacing.episodeKey, state: 'missing' as const },
      ],
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // The replacement stays; an ordinary episode goes first among equals.
    expect(keptKeys.has('z-replacement-requested')).toBe(true);
    expect(keptKeys.has('0-other')).toBe(false);
  });

  it.each([
    { trigger: 'manual', label: 'never requested', requested: false, observed: undefined },
    { trigger: 'scheduled', label: 'never requested', requested: false, observed: undefined },
    { trigger: 'manual', label: 'confirmed missing', requested: true, observed: 'missing' },
    { trigger: 'scheduled', label: 'confirmed missing', requested: true, observed: 'missing' },
  ] as const)(
    'drops an episode without an issue before an unresolved one that has an issue ($label, $trigger scan)',
    ({ trigger, requested, observed }) => {
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
    // Every episode of the state has an issue behind it, except one that never requested any.
    const withIssue = seeded.episodes.map((episode) => ({
      ...episode,
      issueState: 'open' as const,
      issueRequested: true,
    }));
    const withoutIssue = {
      ...template,
      episodeKey: 'episode-without-issue',
      issueKey: issueKeyOf(MAX_ALERT_EPISODES_PER_SITE),
      issueState: 'none' as const,
      issueRequested: requested,
    };

    // On a scheduled scan the episode without an issue is offered an open-issue: a request for
    // an issue that does not exist yet, which must not protect it from the cap.
    const evaluation = evaluateAlertEpisodes({
      trigger,
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: [...withIssue, withoutIssue],
      occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
        group(index, { severity: 'high', validation: 'Confirmed' }),
      ),
      exceptions: [],
      issueStates: [
        ...withIssue.map((episode) => ({ episodeKey: episode.episodeKey, state: 'open' as const })),
        // A confirmed missing issue is no issue behind the episode, even if one was requested.
        ...(observed === undefined
          ? []
          : [{ episodeKey: withoutIssue.episodeKey, state: observed }]),
      ],
    });

    const keptKeys = new Set(evaluation.episodes.map((episode) => episode.episodeKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // The one without an issue goes; every episode with an issue behind it stays, so no
    // group can open a second issue under a new marker.
    expect(keptKeys.has('episode-without-issue')).toBe(false);
    expect(withIssue.every((episode) => keptKeys.has(episode.episodeKey))).toBe(true);
    },
  );
});

import { describe, expect, it } from 'vitest';
import type { RetainedOccurrence, Severity, Validation } from '@mergepilot/webscan';
import { MAX_ALERT_EPISODES_PER_SITE } from './alerts-episodes.js';
import { evaluateAlertEpisodes } from './alerts.js';
import {
  actionsOfKind,
  DASHBOARD_BASE_URL,
  day,
  outstanding,
  runAlertScenario,
  SITE_ID,
  THRESHOLDS,
} from './alerts.fixtures.js';

/**
 * How the engine treats an issue that is reported missing (ADR-0052 section 8).
 *
 * A report that an issue is missing is what offers it again, also when the issue that
 * is missing is the replacement of an earlier one, and it is read against the episode
 * that was persisted even when the evaluation rolls the group over to a new episode.
 */

const EVERY_GROUP = { alertMinSeverity: 'low', alertMinValidation: 'Informational' } as const;

interface GroupLevel {
  severity: Severity;
  validation: Validation;
}

function issueKeyOf(index: number): string {
  return `headers:missing-hsts:host-${String(index).padStart(2, '0')}.test`;
}

function group(index: number, level: GroupLevel): RetainedOccurrence {
  return outstanding({
    occurrenceKey: `occurrence-${String(index).padStart(2, '0')}`,
    targetKey: `target-${String(index).padStart(2, '0')}`,
    issueKey: issueKeyOf(index),
    severity: level.severity,
    validation: level.validation,
  });
}

const HIGH: GroupLevel = { severity: 'high', validation: 'Confirmed' };

describe('an issue that is reported missing', () => {
  it('requests the replacement of a missing issue exactly once, however often it is reported missing', () => {
    const occurrences = [group(0, HIGH)];
    const scenario = runAlertScenario(
      [
        { trigger: 'scheduled', at: day(1), occurrences },
        // The issue is confirmed missing: the replacement is requested.
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences,
          issueStates: [{ issueKey: issueKeyOf(0), state: 'missing' }],
        },
        // Nothing is reported about the replacement yet: it is waited for.
        { trigger: 'scheduled', at: day(3), occurrences },
        // The replacement is reported missing again: still one request per marker, the
        // delivery layer reconciles the delivery by marker.
        {
          trigger: 'scheduled',
          at: day(4),
          occurrences,
          issueStates: [{ issueKey: issueKeyOf(0), state: 'missing' }],
        },
      ],
      { thresholds: EVERY_GROUP },
    );

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(0);
    expect(actionsOfKind(scenario.actions[3] ?? [], 'open-issue')).toHaveLength(0);
  });

  it('is read against the persisted episode when the group rolls over to a new one', () => {
    const seeded = runAlertScenario(
      [
        {
          trigger: 'manual',
          at: day(1),
          occurrences: Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
            group(index, { severity: 'low', validation: 'Confirmed' }),
          ),
        },
      ],
      { thresholds: EVERY_GROUP },
    );
    const withIssue = seeded.episodes.slice(1).map((episode) => ({
      ...episode,
      issueState: 'open' as const,
      issueRequested: true,
    }));
    const rolling = seeded.episodes[0];
    if (rolling === undefined) throw new Error('the seed holds no episode');
    // An issue was requested for the first group; it is reported missing, and the severity of
    // the group rose in the same scan, so the engine starts a new episode for it.
    const requested = { ...rolling, issueState: 'none' as const, issueRequested: true };

    const evaluation = evaluateAlertEpisodes({
      trigger: 'manual',
      now: day(2),
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS, ...EVERY_GROUP },
      episodes: [requested, ...withIssue, {
        ...rolling,
        episodeKey: 'extra-episode',
        issueKey: issueKeyOf(MAX_ALERT_EPISODES_PER_SITE),
        issueState: 'open' as const,
        issueRequested: true,
      }],
      occurrences: [
        group(0, { severity: 'critical', validation: 'Confirmed' }),
        ...Array.from({ length: MAX_ALERT_EPISODES_PER_SITE }, (_value, index) =>
          group(index + 1, { severity: 'low', validation: 'Confirmed' }),
        ),
      ],
      exceptions: [],
      issueStates: [
        { episodeKey: requested.episodeKey, state: 'missing' as const },
        ...withIssue.map((episode) => ({ episodeKey: episode.episodeKey, state: 'open' as const })),
        { episodeKey: 'extra-episode', state: 'open' as const },
      ],
    });

    const keptIssueKeys = new Set(evaluation.episodes.map((episode) => episode.issueKey));
    expect(evaluation.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    // The rolled-over group has no issue behind it, so it goes; every real issue stays.
    expect(keptIssueKeys.has(issueKeyOf(0))).toBe(false);
    expect(withIssue.every((episode) => keptIssueKeys.has(episode.issueKey))).toBe(true);
  });
});

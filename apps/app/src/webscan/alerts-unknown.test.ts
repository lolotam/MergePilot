import { describe, expect, it } from 'vitest';
import {
  actionsOfKind,
  day,
  ISSUE_KEY,
  outstanding,
  provenFixed,
  runAlertScenario,
} from './alerts.fixtures.js';

/**
 * The unknown state of the issue of an episode (ADR-0052 section 8).
 *
 * An unknown state is never closed and never open: it never advances the
 * notification of the episode and never starts a new episode for a group that
 * recurs or that grows stronger, because the issue of the episode may still
 * exist. The episode continues, visibly unknown, until the state of its issue
 * is known.
 */

describe('the unknown state of the issue of an episode', () => {
  it.each(['open', 'closed'] as const)(
    'starts a new episode for a group that recurs while the state of its issue is %s',
    (state) => {
      const scenario = runAlertScenario([
        { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [provenFixed()],
          issueStates: [{ issueKey: ISSUE_KEY, state }],
        },
        {
          trigger: 'scheduled',
          at: day(3),
          occurrences: [outstanding()],
          issueStates: [{ issueKey: ISSUE_KEY, state }],
        },
      ]);

      expect(actionsOfKind(scenario.actions.flat(), 'open-issue')).toHaveLength(2);
      expect(scenario.episodes).toHaveLength(1);
      expect(scenario.episodes[0]?.generation).toBe(1);
    },
  );

  it('never starts a new episode for a group that recurs while the state of its issue is unknown', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'unknown' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'unknown' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions.flat(), 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions.flat(), 'mark-unknown')).toHaveLength(2);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.generation).toBe(0);
    expect(scenario.episodes[0]?.issueState).toBe('unknown');
  });

  it.each(['open', 'closed'] as const)(
    'starts a new episode when the severity of the group rises while the state of its issue is %s',
    (state) => {
      const scenario = runAlertScenario(
        [
          {
            trigger: 'scheduled',
            at: day(1),
            occurrences: [outstanding({ severity: 'medium' })],
          },
          {
            trigger: 'scheduled',
            at: day(2),
            occurrences: [outstanding({ severity: 'high' })],
            issueStates: [{ issueKey: ISSUE_KEY, state }],
          },
        ],
        { thresholds: { alertMinSeverity: 'low' } },
      );

      expect(actionsOfKind(scenario.actions.flat(), 'open-issue')).toHaveLength(2);
      expect(scenario.episodes).toHaveLength(1);
      expect(scenario.episodes[0]?.generation).toBe(1);
      expect(scenario.episodes[0]?.severity).toBe('high');
    },
  );

  it('never starts a new episode when the severity of the group rises while the state of its issue is unknown', () => {
    const scenario = runAlertScenario(
      [
        {
          trigger: 'scheduled',
          at: day(1),
          occurrences: [outstanding({ severity: 'medium' })],
        },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [outstanding({ severity: 'high' })],
          issueStates: [{ issueKey: ISSUE_KEY, state: 'unknown' }],
        },
      ],
      { thresholds: { alertMinSeverity: 'low' } },
    );

    expect(actionsOfKind(scenario.actions.flat(), 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions.flat(), 'mark-unknown')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.generation).toBe(0);
    expect(scenario.episodes[0]?.severity).toBe('medium');
    expect(scenario.episodes[0]?.issueState).toBe('unknown');
  });
});

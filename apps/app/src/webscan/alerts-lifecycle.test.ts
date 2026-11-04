import { describe, expect, it } from 'vitest';
import { renderExceptionCommentBody } from './alerts.js';
import {
  actionsOfKind,
  archived,
  day,
  ISSUE_KEY,
  outstanding,
  provenFixed,
  resolution,
  runAlertScenario,
} from './alerts.fixtures.js';

/**
 * The lifecycle of an alert episode (ADR-0052 section 8).
 *
 * Every test runs several consecutive scans and feeds the episode state of one
 * evaluation into the next one, the way the worker sees the group after every
 * completed scan.
 */

describe('the lifecycle of an alert episode of the website scanner', () => {
  it('joins the episode of its group when the targets churn and never opens a second issue', () => {
    const scenario = runAlertScenario([
      {
        trigger: 'scheduled',
        at: day(1),
        occurrences: [outstanding({ occurrenceKey: 'occurrence-1' })],
      },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding({ occurrenceKey: 'occurrence-2', targetKey: 'target-2' })],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [outstanding({ occurrenceKey: 'occurrence-3', targetKey: 'target-3' })],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[0] ?? [], 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(0);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(0);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.occurrenceKeys).toEqual([
      'occurrence-1',
      'occurrence-2',
      'occurrence-3',
    ]);
  });

  it('never consumes an unnotified episode on a manual scan and delivers it on the next scheduled scan', () => {
    const scenario = runAlertScenario([
      { trigger: 'manual', at: day(1), occurrences: [outstanding()] },
      { trigger: 'scheduled', at: day(2), occurrences: [outstanding()] },
    ]);

    expect(scenario.actions[0]).toHaveLength(0);
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes[0]?.issueRequested).toBe(true);
  });

  it('updates the state of the episode on a manual scan without delivering anything', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'manual',
        at: day(2),
        occurrences: [outstanding({ occurrenceKey: 'occurrence-2' })],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(scenario.actions[1]).toHaveLength(0);
    expect(scenario.episodes[0]?.occurrenceKeys).toEqual(['occurrence-1', 'occurrence-2']);
    expect(scenario.episodes[0]?.issueState).toBe('open');
  });

  it('never reopens a closed issue while the group is unresolved', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'closed' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(0);
    expect(scenario.episodes[0]?.issueState).toBe('closed');
  });

  it('observes a reopened issue on the next evaluation without opening a second one', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'closed' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(0);
    expect(scenario.episodes[0]?.issueState).toBe('open');
    expect(scenario.episodes[0]?.state).toBe('open');
  });

  it('lets a new semantic episode notify even while an older issue stays open', () => {
    const otherKey = 'headers:missing-csp:example.test';
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [
          outstanding(),
          outstanding({
            occurrenceKey: 'occurrence-2',
            issueKey: otherKey,
            issueId: 'missing-csp',
            subject: 'csp',
          }),
        ],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(2);
  });

  it('opens a new episode when a group that was proven fixed comes back', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.generation).toBe(1);
  });

  it('starts a new episode when the eligible severity of the group rises', () => {
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
          issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
        },
      ],
      { thresholds: { alertMinSeverity: 'low' } },
    );

    expect(actionsOfKind(scenario.actions[0] ?? [], 'open-issue')).toHaveLength(1);
    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.generation).toBe(1);
    expect(scenario.episodes[0]?.severity).toBe('high');
  });

  it('never opens a second issue when the eligible level of the group weakens', () => {
    const scenario = runAlertScenario(
      [
        {
          trigger: 'scheduled',
          at: day(1),
          occurrences: [outstanding({ severity: 'high' })],
        },
        {
          trigger: 'scheduled',
          at: day(2),
          occurrences: [outstanding({ severity: 'medium' })],
          issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
        },
        {
          trigger: 'scheduled',
          at: day(3),
          occurrences: [outstanding({ severity: 'critical' })],
          issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
        },
      ],
      { thresholds: { alertMinSeverity: 'low' } },
    );

    expect(actionsOfKind(scenario.actions[1] ?? [], 'open-issue')).toHaveLength(0);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(1);
    expect(scenario.episodes).toHaveLength(1);
    expect(scenario.episodes[0]?.generation).toBe(1);
    expect(scenario.episodes[0]?.severity).toBe('critical');
  });

  it('never opens an issue while the state of the issue is unknown and leaves the episode visibly unknown', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
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
    expect(scenario.episodes[0]?.issueState).toBe('unknown');
  });

  it('opens exactly one replacement issue with the same marker when the issue was confirmed missing', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'missing' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [outstanding()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'missing' }],
      },
    ]);

    const opened = actionsOfKind(scenario.actions.flat(), 'open-issue');
    expect(opened).toHaveLength(2);
    expect(opened[1]?.deliveryMarker).toBe(opened[0]?.deliveryMarker);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'open-issue')).toHaveLength(0);
  });

  it('posts exactly one fixed comment when the coverage proved every member of the group fixed', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    const comments = actionsOfKind(scenario.actions.flat(), 'fixed-comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
    });
    expect(scenario.episodes[0]?.outcome).toBe('fixed');
  });

  it('never posts a fixed comment while one member of the group is still unchecked', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [
          provenFixed({ occurrenceKey: 'occurrence-1' }),
          outstanding({ occurrenceKey: 'occurrence-2', targetKey: 'target-2' }),
        ],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions.flat(), 'fixed-comment')).toHaveLength(0);
  });

  it('never posts a comment while the state of the issue is unknown', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'unknown' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions.flat(), 'fixed-comment')).toHaveLength(0);
    expect(scenario.episodes[0]?.outcome).toBeUndefined();
  });

  it('never posts a fixed comment for an administrator resolution', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
        exceptions: [resolution()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions.flat(), 'fixed-comment')).toHaveLength(0);
  });

  it('posts exactly one resolved by exception comment that names the kind, the reason category and the expiry', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [outstanding()],
        exceptions: [
          resolution({
            expiresAt: new Date('2026-03-01T00:00:00.000Z'),
            reason: 'a private url',
          }),
        ],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    const comments = actionsOfKind(scenario.actions.flat(), 'resolved-by-exception-comment');
    expect(comments).toHaveLength(1);
    const comment = comments[0];
    if (comment?.kind !== 'resolved-by-exception-comment') {
      throw new Error('the scenario did not produce a resolution comment');
    }
    expect(comment.exception.kind).toBe('accepted');
    expect(comment.exception.reasonCategory).toBe('accepted_risk');
    expect(comment.exception.expiresAt).toBe('2026-03-01T00:00:00.000Z');
    expect(renderExceptionCommentBody(comment)).not.toContain('a private url');
    expect(scenario.episodes[0]?.outcome).toBe('resolved-by-exception');
  });

  it('keeps the group blocked while an archived member was never proven fixed', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [archived()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions.flat(), 'fixed-comment')).toHaveLength(0);
    expect(actionsOfKind(scenario.actions.flat(), 'resolved-by-exception-comment')).toHaveLength(0);
    expect(scenario.episodes[0]?.resolved).toBe(false);
  });

  it('posts the fixed comment when the coverage proved an archived member fixed at its exact key', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [archived()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [provenFixed()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(actionsOfKind(scenario.actions[1] ?? [], 'fixed-comment')).toHaveLength(0);
    expect(actionsOfKind(scenario.actions[2] ?? [], 'fixed-comment')).toHaveLength(1);
  });

  it('unblocks a blocked group with a resolved by exception comment when a resolution names the archived identity', () => {
    const scenario = runAlertScenario([
      { trigger: 'scheduled', at: day(1), occurrences: [outstanding()] },
      {
        trigger: 'scheduled',
        at: day(2),
        occurrences: [archived()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
      {
        trigger: 'scheduled',
        at: day(3),
        occurrences: [archived()],
        exceptions: [resolution()],
        issueStates: [{ issueKey: ISSUE_KEY, state: 'open' }],
      },
    ]);

    expect(
      actionsOfKind(scenario.actions[1] ?? [], 'resolved-by-exception-comment'),
    ).toHaveLength(0);
    expect(
      actionsOfKind(scenario.actions[2] ??[], 'resolved-by-exception-comment'),
    ).toHaveLength(1);
    expect(actionsOfKind(scenario.actions.flat(), 'fixed-comment')).toHaveLength(0);
  });
});

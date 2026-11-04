import { describe, expect, it } from 'vitest';
import {
  deliveryMarker,
  evaluateAlertEpisodes,
  renderFixedCommentBody,
  renderIssueBody,
} from './alerts.js';
import type { AlertAction, AlertEvaluationInput } from './alerts-types.js';
import {
  actionsOfKind,
  DASHBOARD_BASE_URL,
  NOW,
  openIssueAction,
  outstanding,
  resolution,
  SITE_ID,
  THRESHOLDS,
} from './alerts.fixtures.js';
import type { WebScanAlertEpisode } from './types.js';

/**
 * The eligibility and the publication of an alert (ADR-0052 section 8).
 *
 * Every test reads like one requirement of the specification, and every test
 * can fail: a broken threshold, a broken exception or a broken payload makes
 * exactly one of them fail.
 */

/** The evaluation of one ledger, with the default fixtures. */
function evaluate(
  overrides: Partial<AlertEvaluationInput> = {},
): { actions: AlertAction[]; episodes: WebScanAlertEpisode[] } {
  const result = evaluateAlertEpisodes({
    trigger: 'scheduled',
    now: NOW,
    siteId: SITE_ID,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
    thresholds: THRESHOLDS,
    episodes: [],
    occurrences: [outstanding()],
    exceptions: [],
    ...overrides,
  });
  return { actions: result.actions, episodes: result.episodes };
}

/** Freezes an input deeply, so a mutation of it throws. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

describe('the eligibility of an alert of the website scanner', () => {
  it('opens one issue for an eligible finding and publishes only aggregate counts and the dashboard link', () => {
    const { actions, episodes } = evaluate();

    expect(actions).toHaveLength(1);
    const action = openIssueAction(actions);
    expect(action?.severityCounts).toEqual({
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
    });
    expect(action?.dashboardUrl).toBe('https://dashboard.test/admin/web-scan/sites/site-1');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.issueState).toBe('none');
  });

  it.each([
    { severity: 'low', validation: 'Confirmed' },
    { severity: 'medium', validation: 'Confirmed' },
    { severity: 'high', validation: 'Indicator' },
    { severity: 'high', validation: 'Informational' },
  ] as const)(
    'never opens an issue for a finding of severity %s and validation %s',
    (finding) => {
      const { actions, episodes } = evaluate({
        occurrences: [
          outstanding({ severity: finding.severity, validation: finding.validation }),
        ],
      });

      expect(actions).toHaveLength(0);
      expect(episodes).toHaveLength(0);
    },
  );

  it('never opens an issue for a finding that carries an active exception', () => {
    const { actions } = evaluate({ exceptions: [resolution()] });

    expect(actions).toHaveLength(0);
  });

  it('returns the finding to the eligible state when its exception no longer matches its evidence', () => {
    const { actions } = evaluate({
      exceptions: [resolution({ evidenceHash: 'another-evidence-hash' })],
    });

    expect(actionsOfKind(actions, 'open-issue')).toHaveLength(1);
  });

  it.each([
    {
      label: 'expired',
      exception: resolution({ expiresAt: new Date('2026-01-20T00:00:00.000Z') }),
    },
    {
      label: 'revoked',
      exception: resolution({
        revokedAt: new Date('2026-01-20T00:00:00.000Z'),
        revokedBy: 'admin-1',
      }),
    },
  ])('returns the finding to the eligible state when its resolution is $label', ({ exception }) => {
    const { actions } = evaluate({ exceptions: [exception] });

    expect(actionsOfKind(actions, 'open-issue')).toHaveLength(1);
  });

  it('produces no action at all when alerts are switched off', () => {
    const { actions, episodes } = evaluate({
      thresholds: { ...THRESHOLDS, alertsEnabled: false },
    });

    expect(actions).toHaveLength(0);
    expect(episodes).toHaveLength(0);
  });

  it('returns an archived member to the eligible state with the fields of its retained identity', () => {
    const { actions } = evaluate({
      occurrences: [
        outstanding({
          occurrenceKey: 'occurrence-9',
          evidence: null,
          severity: 'critical',
          validation: 'Confirmed',
        }),
      ],
    });

    const opened = actionsOfKind(actions, 'open-issue');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.severityCounts).toEqual({
      critical: 1,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
  });

  it('never publishes a fact of the ledger in the payload of an action', () => {
    const hostile = 'https://example.test/private?token=leak';
    const { actions } = evaluate({
      occurrences: [
        outstanding({
          occurrenceKey: hostile,
          targetKey: hostile,
          subject: hostile,
          safeLocation: hostile,
          evidenceHash: hostile,
          issueKey: `headers:missing-hsts:${hostile}`,
          evidence: { detail: hostile },
        }),
      ],
      exceptions: [resolution({ reason: hostile })],
    });

    const action = openIssueAction(actions);
    if (action === undefined) {
      throw new Error('the evaluation did not open an issue');
    }
    const payload = `${JSON.stringify(actions)}${renderIssueBody(action)}`;
    expect(payload).not.toContain(hostile);
    expect(payload).not.toContain('example.test');
    expect(payload).not.toContain('occurrence-1');
  });

  it('never mutates its input and always returns the same result', () => {
    const input = deepFreeze<AlertEvaluationInput>({
      trigger: 'scheduled',
      now: NOW,
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: { ...THRESHOLDS },
      episodes: [],
      occurrences: [outstanding()],
      exceptions: [resolution()],
    });

    const first = evaluateAlertEpisodes(input);
    const second = evaluateAlertEpisodes(input);

    expect(second).toEqual(first);
  });

  it('gives the same marker to the same episode and a different marker to another episode', () => {
    const episode: WebScanAlertEpisode = {
      episodeKey: 'ep-1',
      issueKey: 'headers:missing-hsts:example.test',
      state: 'open',
      occurrenceKeys: [],
      lastChangedAt: NOW.toISOString(),
    };
    const other: WebScanAlertEpisode = { ...episode, episodeKey: 'ep-2' };

    expect(deliveryMarker(episode)).toBe(deliveryMarker(episode));
    expect(deliveryMarker(episode)).not.toBe(deliveryMarker(other));
    expect(deliveryMarker(episode, 'fixed-comment')).not.toBe(deliveryMarker(episode));
    expect(deliveryMarker(episode, 'fixed-comment')).toBe(
      deliveryMarker(episode, 'fixed-comment'),
    );
    expect(deliveryMarker(episode, 'fixed-comment')).not.toBe(
      deliveryMarker(episode, 'resolved-by-exception-comment'),
    );
    expect(deliveryMarker(episode, 'mark-unknown')).not.toBe(deliveryMarker(episode));
  });

  it('renders a body that carries the counts, the dashboard link and the marker only', () => {
    const { actions } = evaluate();
    const action = openIssueAction(actions);
    if (action === undefined) {
      throw new Error('the evaluation did not open an issue');
    }

    const body = renderIssueBody(action);
    expect(body).toContain('- High: 1');
    expect(body).toContain('https://dashboard.test/admin/web-scan/sites/site-1');
    expect(body).toContain(action.deliveryMarker);
    expect(renderFixedCommentBody({ ...action, kind: 'fixed-comment' })).toContain('- High: 1');
  });
});

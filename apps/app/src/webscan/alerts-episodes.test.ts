import { describe, expect, it } from 'vitest';
import { evaluateAlertEpisodes } from './alerts.js';
import {
  MAX_ALERT_EPISODES_PER_SITE,
  MAX_ALERT_EPISODE_OCCURRENCES,
  capEpisodes,
  episodeEvictionOrder,
  mergeOccurrenceKeys,
} from './alerts-episodes.js';
import {
  DASHBOARD_BASE_URL,
  ISSUE_KEY,
  NOW,
  outstanding,
  SITE_ID,
  THRESHOLDS,
} from './alerts.fixtures.js';
import type { WebScanAlertEpisode } from './types.js';

/**
 * The bounded episode state of a site (ADR-0052 section 8).
 *
 * The bound and its eviction are the reason the state of a site can never grow
 * without a limit, so they are proven here.
 */

/** One episode of a fixture site. */
function episode(overrides: Partial<WebScanAlertEpisode> = {}): WebScanAlertEpisode {
  return {
    episodeKey: 'ep-1',
    issueKey: ISSUE_KEY,
    state: 'open',
    occurrenceKeys: [],
    lastChangedAt: NOW.toISOString(),
    issueState: 'none',
    issueRequested: false,
    resolved: false,
    ...overrides,
  };
}

describe('the bounded episode state of the website scanner', () => {
  it('keeps at most the bounded number of episodes of a site', () => {
    const episodes = Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 5 }, (_value, index) =>
      episode({
        episodeKey: `ep-${index}`,
        issueKey: `headers:missing-hsts:host-${index}.test`,
        lastChangedAt: new Date(NOW.getTime() + index * 1000).toISOString(),
      }),
    );

    const capped = capEpisodes(episodes);

    expect(capped).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
  });

  it('keeps at most the bounded number of episodes when the site grows past the bound', () => {
    const occurrences = Array.from(
      { length: MAX_ALERT_EPISODES_PER_SITE + 3 },
      (_value, index) =>
        outstanding({
          occurrenceKey: `occurrence-${index}`,
          issueKey: `headers:missing-hsts:host-${index}.test`,
        }),
    );

    const result = evaluateAlertEpisodes({
      trigger: 'scheduled',
      now: NOW,
      siteId: SITE_ID,
      dashboardBaseUrl: DASHBOARD_BASE_URL,
      thresholds: THRESHOLDS,
      episodes: [],
      occurrences,
      exceptions: [],
    });

    expect(result.episodes).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
  });

  it('evicts a resolved episode before an unresolved one and the oldest episode before the newest one', () => {
    const resolved = episode({
      episodeKey: 'ep-resolved',
      issueKey: 'b',
      lastChangedAt: '2026-01-01T00:00:00.000Z',
      resolved: true,
    });
    const unresolved = episode({
      episodeKey: 'ep-unresolved',
      issueKey: 'a',
      lastChangedAt: '2026-01-01T00:00:00.000Z',
      resolved: false,
    });
    const newest = episode({
      episodeKey: 'ep-newest',
      issueKey: 'c',
      lastChangedAt: '2026-02-01T00:00:00.000Z',
      resolved: false,
    });

    expect(episodeEvictionOrder(resolved, unresolved)).toBeLessThan(0);
    expect(episodeEvictionOrder(unresolved, newest)).toBeLessThan(0);
    expect(episodeEvictionOrder(newest, unresolved)).toBeGreaterThan(0);
  });

  it('drops the oldest episode when the site grows past the bound', () => {
    const episodes = Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 1 }, (_value, index) =>
      episode({
        episodeKey: `ep-${index}`,
        issueKey: `issue-${index}`,
        lastChangedAt: new Date(NOW.getTime() + index * 1000).toISOString(),
      }),
    );

    const capped = capEpisodes(episodes);

    expect(capped).toHaveLength(MAX_ALERT_EPISODES_PER_SITE);
    expect(capped.map((entry) => entry.issueKey)).not.toContain('issue-0');
  });

  it('evicts the same episodes every time, whatever the order of the input', () => {
    const episodes = Array.from({ length: MAX_ALERT_EPISODES_PER_SITE + 4 }, (_value, index) =>
      episode({
        episodeKey: `ep-${index}`,
        issueKey: `issue-${index}`,
        lastChangedAt: new Date(NOW.getTime() + index * 1000).toISOString(),
      }),
    );

    const first = capEpisodes(episodes);
    const second = capEpisodes([...episodes].reverse());

    expect(second).toEqual(first);
  });

  it('bounds the occurrence keys of one episode', () => {
    const keys = Array.from({ length: MAX_ALERT_EPISODE_OCCURRENCES + 10 }, (_value, index) =>
      `occurrence-${index}`,
    );

    const merged = mergeOccurrenceKeys([], keys);

    expect(merged).toHaveLength(MAX_ALERT_EPISODE_OCCURRENCES);
    expect(merged[merged.length - 1]).toBe(`occurrence-${keys.length - 1}`);
  });

  it('never lets an episode keep the same occurrence key twice', () => {
    const merged = mergeOccurrenceKeys(['occurrence-1'], ['occurrence-1', 'occurrence-2']);

    expect(merged).toEqual(['occurrence-1', 'occurrence-2']);
  });
});

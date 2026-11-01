import { describe, expect, it } from 'vitest';

import {
  canonicalTargetDescription,
  computeIssueKey,
  computeOccurrenceKey,
  computeTargetKey,
  createSiteIdentity,
  safeDisplayUrl,
} from './identity.js';
import { parseCanonicalUrl } from './scope.js';

const SITE_KEY = new Uint8Array(32).fill(7);
const OTHER_SITE_KEY = new Uint8Array(32).fill(9);

const BASELINE = 'https://example.com/docs?id=1';
const MUTATED_PROBE = "https://example.com/docs?id=1%27%20OR%201%3D1--";

describe('the target identity', () => {
  it('is deterministic for the same baseline URL', () => {
    expect(computeTargetKey(BASELINE, SITE_KEY)).toBe(computeTargetKey(BASELINE, SITE_KEY));
  });

  it('is stable when the same target is discovered again', () => {
    const identity = createSiteIdentity(SITE_KEY);

    expect(identity.identifyTarget(BASELINE)).toBe(identity.identifyTarget(BASELINE));
  });

  it('differs between two sites', () => {
    expect(computeTargetKey(BASELINE, SITE_KEY)).not.toBe(computeTargetKey(BASELINE, OTHER_SITE_KEY));
  });

  it('ignores the order of the query parameter names', () => {
    expect(computeTargetKey('https://example.com/docs?a=1&b=2', SITE_KEY)).toBe(
      computeTargetKey('https://example.com/docs?b=2&a=1', SITE_KEY),
    );
  });

  it('describes a target with the query parameter names in another order the same way', () => {
    expect(
      canonicalTargetDescription(parseCanonicalUrl('https://example.com/docs?a=1&b=2')),
    ).toBe(canonicalTargetDescription(parseCanonicalUrl('https://example.com/docs?b=2&a=1')));
  });

  it('describes two query variants of one path differently', () => {
    expect(
      canonicalTargetDescription(parseCanonicalUrl('https://example.com/docs?a=1&b=2')),
    ).not.toBe(canonicalTargetDescription(parseCanonicalUrl('https://example.com/docs?a=2&b=2')));
  });

  it('differs when a query value changes', () => {
    expect(computeTargetKey('https://example.com/docs?id=1', SITE_KEY)).not.toBe(
      computeTargetKey('https://example.com/docs?id=2', SITE_KEY),
    );
  });

  it('differs when a query parameter name changes', () => {
    expect(computeTargetKey('https://example.com/docs?id=1', SITE_KEY)).not.toBe(
      computeTargetKey('https://example.com/docs?ref=1', SITE_KEY),
    );
  });

  it('keeps the order of repeated values of one parameter name', () => {
    expect(computeTargetKey('https://example.com/docs?id=1&id=2', SITE_KEY)).not.toBe(
      computeTargetKey('https://example.com/docs?id=2&id=1', SITE_KEY),
    );
  });

  it('separates repeated values from another parameter name and value', () => {
    expect(computeTargetKey('https://example.com/docs?a=b&a=c&a=d', SITE_KEY)).not.toBe(
      computeTargetKey('https://example.com/docs?a=b&c=d', SITE_KEY),
    );
  });

  it('gives the same identity to the same repeated values', () => {
    expect(computeTargetKey('https://example.com/docs?id=1&id=2', SITE_KEY)).toBe(
      computeTargetKey('https://example.com/docs?id=1&id=2', SITE_KEY),
    );
  });

  it('differs for another host and another path', () => {
    expect(computeTargetKey('https://example.com/docs', SITE_KEY)).not.toBe(
      computeTargetKey('https://other.example.com/docs', SITE_KEY),
    );
    expect(computeTargetKey('https://example.com/docs', SITE_KEY)).not.toBe(
      computeTargetKey('https://example.com/docs/a', SITE_KEY),
    );
  });

  it('never carries the raw query value into the digest', () => {
    const identity = computeTargetKey('https://example.com/docs?token=supersecretvalue', SITE_KEY);

    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(identity).not.toContain('supersecretvalue');
  });

  it('is never derived from a mutated probe', () => {
    expect(computeTargetKey(BASELINE, SITE_KEY)).not.toBe(computeTargetKey(MUTATED_PROBE, SITE_KEY));
  });

  it('refuses a key that is too weak to use', () => {
    expect(() => computeTargetKey(BASELINE, new Uint8Array(4))).toThrow();
  });
});

describe('the occurrence identity', () => {
  const targetKey = computeTargetKey(BASELINE, SITE_KEY);

  it('is stable for the same occurrence', () => {
    const input = { targetKey, checkId: 'cookies', issueId: 'cookie-missing-secure', subject: 'session' } as const;

    expect(computeOccurrenceKey(input, SITE_KEY)).toBe(computeOccurrenceKey(input, SITE_KEY));
  });

  it('separates two cookie subjects', () => {
    const base = { targetKey, checkId: 'cookies', issueId: 'cookie-missing-secure' } as const;

    expect(computeOccurrenceKey({ ...base, subject: 'session' }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, subject: 'csrf' }, SITE_KEY),
    );
  });

  it('separates two checks and two issue ids', () => {
    const base = { targetKey, issueId: 'cookie-missing-secure', subject: 'session' } as const;

    expect(computeOccurrenceKey({ ...base, checkId: 'cookies' }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, checkId: 'headers' }, SITE_KEY),
    );
    expect(computeOccurrenceKey({ ...base, checkId: 'cookies' }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, checkId: 'cookies', issueId: 'cookie-missing-httponly' }, SITE_KEY),
    );
  });

  it('separates two targets', () => {
    const otherTargetKey = computeTargetKey('https://example.com/docs?id=2', SITE_KEY);
    const base = { checkId: 'cookies', issueId: 'cookie-missing-secure', subject: 'session' } as const;

    expect(computeOccurrenceKey({ ...base, targetKey }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, targetKey: otherTargetKey }, SITE_KEY),
    );
  });

  it('does not collide for two query variants of the same path', () => {
    const first = computeTargetKey('https://example.com/docs?id=1', SITE_KEY);
    const second = computeTargetKey('https://example.com/docs?id=2', SITE_KEY);
    const base = { checkId: 'cookies', issueId: 'cookie-missing-secure', subject: 'session' } as const;

    expect(computeOccurrenceKey({ ...base, targetKey: first }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, targetKey: second }, SITE_KEY),
    );
  });

  it('never lets a negative on one variant fix another variant', () => {
    const first = computeTargetKey('https://example.com/docs?id=1', SITE_KEY);
    const second = computeTargetKey('https://example.com/docs?id=2', SITE_KEY);
    const base = { checkId: 'cookies', issueId: 'cookie-missing-secure', subject: 'session' } as const;

    // A successful negative on the second variant carries the second variant's
    // identity, so it can never be applied to the first occurrence. The
    // comparison that turns a matching negative into a Fixed transition is
    // part of Task 4 and is deliberately not implemented here.
    expect(computeOccurrenceKey({ ...base, targetKey: second }, SITE_KEY)).not.toBe(
      computeOccurrenceKey({ ...base, targetKey: first }, SITE_KEY),
    );
  });

  it('keeps the identity of a rediscovered variant across separate runs', () => {
    const firstRun = createSiteIdentity(SITE_KEY).identifyTarget('https://example.com/docs?id=7');
    const secondRun = createSiteIdentity(SITE_KEY).identifyTarget('https://example.com/docs?id=7');

    expect(secondRun).toBe(firstRun);
  });
});

describe('the issue identity', () => {
  it('is the check, the issue and the canonical host', () => {
    expect(computeIssueKey({ checkId: 'cookies', issueId: 'cookie-missing-secure', hostname: 'example.com' })).toBe(
      'cookies|cookie-missing-secure|example.com',
    );
  });

  it('ignores the case and the trailing dot of the host', () => {
    expect(computeIssueKey({ checkId: 'cookies', issueId: 'cookie-missing-secure', hostname: 'EXAMPLE.com.' })).toBe(
      'cookies|cookie-missing-secure|example.com',
    );
  });

  it('differs for another host, another check and another issue', () => {
    const base = { checkId: 'cookies', issueId: 'cookie-missing-secure', hostname: 'example.com' } as const;

    expect(computeIssueKey({ ...base, hostname: 'other.example.com' })).not.toBe(computeIssueKey(base));
    expect(computeIssueKey({ ...base, checkId: 'headers' })).not.toBe(computeIssueKey(base));
    expect(computeIssueKey({ ...base, issueId: 'cookie-missing-httponly' })).not.toBe(computeIssueKey(base));
  });
});

describe('the safe display', () => {
  it('removes the userinfo', () => {
    const display = safeDisplayUrl('https://user:pass@example.com/docs');

    expect(display).not.toContain('user');
    expect(display).not.toContain('pass');
    expect(display.startsWith('https://example.com/')).toBe(true);
  });

  it('removes the fragment', () => {
    expect(safeDisplayUrl('https://example.com/docs#secret')).not.toContain('#');
  });

  it('replaces every query value and keeps the parameter names', () => {
    const display = safeDisplayUrl('https://example.com/docs?token=abcd1234&page=2');

    expect(display).not.toContain('abcd1234');
    expect(display).not.toContain('2');
    expect(display).toContain('token=REDACTED');
    expect(display).toContain('page=REDACTED');
  });

  it('uses safe placeholders for a dynamic path', () => {
    expect(safeDisplayUrl('https://example.com/users/abc123/posts')).toBe(
      'https://example.com/{segment}/{segment}/{segment}',
    );
  });

  it('shows an approved route literally', () => {
    const display = safeDisplayUrl('https://example.com/docs/a', {
      approvedRoutes: [{ path: '/docs', kind: 'prefix' }],
    });

    expect(display).toBe('https://example.com/docs');
  });

  it('never leaks a path or query secret', () => {
    const display = safeDisplayUrl('https://example.com/users/s3cr3t-token?session=abcd1234');

    expect(display).not.toContain('s3cr3t');
    expect(display).not.toContain('abcd1234');
  });

  it('keeps the host, because the host is the site the administrator listed', () => {
    expect(safeDisplayUrl('https://example.com/docs?a=1').startsWith('https://example.com')).toBe(true);
  });

  it('re-encodes a parameter name so it cannot fake another parameter', () => {
    const display = safeDisplayUrl('https://example.com/docs?a%26b=1');

    expect(display).toBe('https://example.com/{segment}?a%26b=REDACTED');
    expect(display.split('?')[1]?.split('&')).toHaveLength(1);
  });

  it('returns a safe placeholder for a URL it cannot use', () => {
    expect(safeDisplayUrl('not a url')).toBe('(invalid-url)');
    expect(safeDisplayUrl('javascript:alert(1)')).toBe('(invalid-url)');
  });
});

describe('the site identity factory', () => {
  it('binds one site key to both identity functions', () => {
    const identity = createSiteIdentity(SITE_KEY);
    const targetKey = identity.identifyTarget(BASELINE);

    expect(targetKey).toBe(computeTargetKey(BASELINE, SITE_KEY));
    expect(
      identity.identifyOccurrence({
        targetKey,
        checkId: 'cookies',
        issueId: 'cookie-missing-secure',
        subject: 'session',
      }),
    ).toBe(
      computeOccurrenceKey(
        { targetKey, checkId: 'cookies', issueId: 'cookie-missing-secure', subject: 'session' },
        SITE_KEY,
      ),
    );
  });

  it('never shares one key between two sites', () => {
    const first = createSiteIdentity(SITE_KEY);
    const second = createSiteIdentity(OTHER_SITE_KEY);

    expect(first.identifyTarget(BASELINE)).not.toBe(second.identifyTarget(BASELINE));
  });
});

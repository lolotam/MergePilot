import { describe, expect, it } from 'vitest';

import { evaluateCookies } from './cookies.js';
import { createCheckContext, createTarget } from './check.fixtures.js';

function issueIds(findings: readonly { issueId: string }[]): readonly string[] {
  return findings.map((finding) => finding.issueId);
}

describe('the cookie check', () => {
  it('reads every Set-Cookie header of a response on its own', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: {
            'set-cookie': [
              'session=s3cret-value; Path=/; Secure; HttpOnly; SameSite=Lax',
              'tracker=other-value; Path=/',
            ],
          },
        }),
      ],
    });

    const results = await evaluateCookies(context);

    const findings = results[0]?.findings ?? [];
    expect(issueIds(findings)).toEqual([
      'cookie-without-secure',
      'cookie-without-http-only',
      'cookie-without-same-site',
    ]);
    // The two cookies are two subjects, so they are two occurrences.
    expect(findings.every((finding) => finding.subject === 'tracker')).toBe(true);
    expect(new Set(findings.map((finding) => finding.occurrenceKey)).size).toBe(3);
  });

  it('reports nothing for a cookie that carries every attribute', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: {
            'set-cookie': 'session=abc; Path=/; Secure; HttpOnly; SameSite=Strict',
          },
        }),
      ],
    });

    const results = await evaluateCookies(context);

    expect(results[0]?.findings).toEqual([]);
    expect(results[0]?.coverage.evaluatedIssueIds).toEqual([
      'cookie-without-secure',
      'cookie-without-http-only',
      'cookie-without-same-site',
    ]);
  });

  it('keeps the value of a cookie out of the finding and out of the fingerprint', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: { 'set-cookie': 'session=s3cret-cookie-value; Path=/' },
        }),
      ],
    });

    const results = await evaluateCookies(context);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('s3cret-cookie-value');
    expect(serialized).not.toContain('session=');
    const finding = results[0]?.findings[0];
    expect(finding?.subject).toBe('session');
    expect(finding?.evidence).toEqual({
      name: 'session',
      secure: false,
      http_only: false,
      same_site: 'unset',
    });
  });

  it('treats an unknown SameSite value as no same-site policy', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: { 'set-cookie': 'session=abc; Secure; HttpOnly; SameSite=Whatever' },
        }),
      ],
    });

    const results = await evaluateCookies(context);

    expect(issueIds(results[0]?.findings ?? [])).toEqual(['cookie-without-same-site']);
    expect(results[0]?.findings[0]?.evidence?.same_site).toBe('unset');
  });

  it('keeps the cookies of a redirect whose destination was denied', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          status: 302,
          headers: {
            location: 'https://example.com/login',
            'set-cookie': 'session=abc; Path=/',
          },
          destinationReached: false,
        }),
      ],
    });

    const results = await evaluateCookies(context);

    expect(results[0]?.coverage.outcome).toBe('checked');
    expect(results[0]?.findings.length).toBe(3);
  });
});

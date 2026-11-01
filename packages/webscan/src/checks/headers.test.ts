import { describe, expect, it } from 'vitest';

import { evaluateHeaders } from './headers.js';
import { createCheckContext, createTarget } from './check.fixtures.js';

const SECURE_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; script-src 'nonce-abc123'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=()',
};

function issueIds(findings: readonly { issueId: string }[]): readonly string[] {
  return findings.map((finding) => finding.issueId);
}

describe('the header check', () => {
  it('reports every missing header of a page without one', async () => {
    const context = createCheckContext({
      targets: [createTarget({ url: 'https://example.com/' })],
    });

    const results = await evaluateHeaders(context);

    const findings = results[0]?.findings ?? [];
    expect(issueIds(findings)).toEqual([
      'missing-strict-transport-security',
      'missing-content-security-policy',
      'missing-content-type-options',
      'missing-referrer-policy',
      'missing-permissions-policy',
      'missing-frame-protection',
    ]);
    expect(findings.every((finding) => finding.validation === 'Confirmed')).toBe(true);
  });

  it('reports nothing when every policy is valid', async () => {
    const context = createCheckContext({
      targets: [createTarget({ url: 'https://example.com/', headers: SECURE_HEADERS })],
    });

    const results = await evaluateHeaders(context);

    expect(results[0]?.findings).toEqual([]);
    expect(results[0]?.coverage.outcome).toBe('checked');
  });

  it('accepts the valid alternatives of every policy', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: {
            'strict-transport-security': 'max-age=600',
            'content-security-policy': 'frame-ancestors https://example.com',
            'x-content-type-options': 'NoSniff',
            'referrer-policy': 'strict-origin-when-cross-origin',
            'permissions-policy': 'geolocation=(self)',
          },
        }),
      ],
    });

    const results = await evaluateHeaders(context);

    // The CSP frame-ancestors directive protects the page without an
    // X-Frame-Options header.
    expect(issueIds(results[0]?.findings ?? [])).toEqual([]);
  });

  it('reports the invalid variants of a present header', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: {
            'strict-transport-security': 'includeSubDomains',
            'content-security-policy': 'nonsense-directive',
            'x-frame-options': 'ALLOW-FROM https://example.com',
            'x-content-type-options': 'off',
            'referrer-policy': 'whatever',
            'permissions-policy': 'geolocation=(',
          },
        }),
      ],
    });

    const results = await evaluateHeaders(context);

    expect(issueIds(results[0]?.findings ?? [])).toEqual([
      'invalid-strict-transport-security',
      'invalid-content-security-policy',
      'invalid-content-type-options',
      'invalid-referrer-policy',
      'invalid-permissions-policy',
      'invalid-frame-protection',
    ]);
  });

  it('treats a zero max-age as no policy at all', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: { 'strict-transport-security': 'max-age=0' },
        }),
      ],
    });

    const results = await evaluateHeaders(context);

    expect(issueIds(results[0]?.findings ?? [])).toContain(
      'invalid-strict-transport-security',
    );
  });

  it('keeps a nonce and every other header value out of the evidence', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: {
            'content-security-policy': "script-src 'nonce-s3cret-nonce-value' 'strict-dynamic'",
            'server': 'nginx/1.18.0',
          },
        }),
      ],
    });

    const results = await evaluateHeaders(context);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('s3cret-nonce-value');
    expect(serialized).not.toContain('strict-dynamic');
    expect(serialized).not.toContain('nginx');
  });

  it('evaluates the headers of a redirect whose destination was denied', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          status: 302,
          headers: { location: 'https://example.com/login' },
          destinationReached: false,
        }),
      ],
    });

    const results = await evaluateHeaders(context);

    expect(results[0]?.coverage.outcome).toBe('checked');
    expect(results[0]?.coverage.evaluatedIssueIds).toContain(
      'missing-strict-transport-security',
    );
    expect(results[0]?.findings.length).toBeGreaterThan(0);
  });

  it('lists every header issue it evaluated', async () => {
    const context = createCheckContext({
      targets: [createTarget({ url: 'https://example.com/' })],
    });

    const results = await evaluateHeaders(context);

    expect(results[0]?.coverage.evaluatedIssueIds).toEqual([
      'missing-strict-transport-security',
      'invalid-strict-transport-security',
      'missing-content-security-policy',
      'invalid-content-security-policy',
      'missing-content-type-options',
      'invalid-content-type-options',
      'missing-referrer-policy',
      'invalid-referrer-policy',
      'missing-permissions-policy',
      'invalid-permissions-policy',
      'missing-frame-protection',
      'invalid-frame-protection',
    ]);
    expect(results[0]?.coverage.checkVersion).toBe(1);
  });
});

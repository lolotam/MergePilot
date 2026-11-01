import { describe, expect, it } from 'vitest';

import { evaluateDisclosure } from './disclosure.js';
import { createCheckContext, createTarget } from './check.fixtures.js';

function issueIds(findings: readonly { issueId: string }[]): readonly string[] {
  return findings.map((finding) => finding.issueId);
}

describe('the disclosure check', () => {
  it('reports a server header that discloses a version', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({ url: 'https://example.com/', headers: { server: 'nginx/1.18.0' } }),
      ],
    });

    const results = await evaluateDisclosure(context);

    const finding = results[0]?.findings[0];
    expect(finding?.issueId).toBe('server-version-disclosure');
    expect(finding?.validation).toBe('Confirmed');
    expect(finding?.evidence).toEqual({ header: 'server', signature: 'nginx' });
  });

  it('reports an X-Powered-By header that discloses a version', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: { 'x-powered-by': 'PHP/8.1.2' },
        }),
      ],
    });

    const results = await evaluateDisclosure(context);

    const finding = results[0]?.findings[0];
    expect(finding?.issueId).toBe('powered-by-version-disclosure');
    expect(finding?.evidence).toEqual({ header: 'x-powered-by', signature: 'php' });
  });

  it('reports nothing for a server header without a version', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({ url: 'https://example.com/', headers: { server: 'nginx', 'x-powered-by': 'Express' } }),
      ],
    });

    const results = await evaluateDisclosure(context);

    expect(results[0]?.findings).toEqual([]);
  });

  it('keeps the version and the stack trace out of the evidence', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          headers: { server: 'Apache/2.4.41 (Ubuntu)' },
          body: 'Fatal error: Uncaught Error in /var/www/app/secret/path.php on line 42',
        }),
      ],
    });

    const results = await evaluateDisclosure(context);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('2.4.41');
    expect(serialized).not.toContain('secret/path.php');
    const stackTrace = results[0]?.findings.find(
      (finding) => finding.issueId === 'stack-trace-disclosure',
    );
    expect(stackTrace?.validation).toBe('Likely');
    expect(stackTrace?.evidence).toEqual({ signature: 'php-stack-trace' });
  });

  it('reports a stack trace of an error page', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          status: 500,
          body: 'Traceback (most recent call last):\n  File "/srv/app/main.py", line 3',
        }),
      ],
    });

    const results = await evaluateDisclosure(context);

    const finding = results[0]?.findings[0];
    expect(finding?.issueId).toBe('stack-trace-disclosure');
    expect(finding?.evidence).toEqual({ signature: 'python-traceback' });
  });

  it('leaves the body issue unchecked when the destination was denied', async () => {
    const context = createCheckContext({
      targets: [
        createTarget({
          url: 'https://example.com/',
          status: 302,
          headers: { location: 'https://example.com/login', server: 'nginx/1.18.0' },
          body: 'Fatal error: Uncaught Error',
          destinationReached: false,
        }),
      ],
    });

    const results = await evaluateDisclosure(context);

    expect(results[0]?.coverage.evaluatedIssueIds).toEqual([
      'server-version-disclosure',
      'powered-by-version-disclosure',
    ]);
    expect(issueIds(results[0]?.findings ?? [])).toEqual(['server-version-disclosure']);
  });
});

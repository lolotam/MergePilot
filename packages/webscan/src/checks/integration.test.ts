import { describe, expect, it } from 'vitest';

import { runScan } from '../run.js';
import { ScanTransportError } from '../errors.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  textResponse,
  type RecordedCall,
} from '../test-support.fixtures.js';
import type { CheckSwitches, ScanInput } from '../types.js';

/** Every check of the catalogue is switched off. */
const EVERY_CHECK_OFF: CheckSwitches = {
  headers: false,
  cookies: false,
  transport: false,
  disclosure: false,
  files: false,
  active: false,
};

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    scope: createScope(),
    limits: createLimits(),
    checks: {
      headers: true,
      cookies: true,
      transport: true,
      disclosure: true,
      files: true,
      active: true,
    },
    contact: 'ops@example.com',
    ...overrides,
  };
}

/** The URLs the scan requested. */
function requestedUrls(calls: readonly RecordedCall[]): readonly string[] {
  return calls.map((call) => call.url);
}

describe('the default scan', () => {
  it('keeps a reflected-marker finding when the next link hits the request cap', async () => {
    const transport = createFakeTransport((call) => {
      if (call.url === 'https://example.com/') {
        return textResponse('<a href="/search?q=books">one</a><a href="/search?q=other">two</a>');
      }
      const query = new URL(call.url).searchParams.get('q') ?? '';
      return textResponse(query.includes('mpws reflect 7q') ? '<p>mpws reflect 7q</p>' : 'results');
    });
    const { deps } = createDependencies(transport);
    const scope = createScope({
      parameterizedPaths: [{ path: '/search', parameters: ['q'] }],
      activePaths: [{ path: '/search', parameters: ['q'] }],
    });

    const result = await runScan(input({
      scope,
      checks: { ...EVERY_CHECK_OFF, active: true },
      limits: createLimits({ maxRequests: 4 }),
    }), deps);

    expect(result).toMatchObject({ status: 'stopped', reason: 'request_limit', partialCoverage: true });
    expect(result.findings.filter((finding) => finding.issueId === 'reflection-indicator')).toHaveLength(1);
    expect(transport.calls).toHaveLength(4);
  });

  it.each(['transport-error', 'server-error'])('reports partial coverage when a file has a %s', async (failure) => {
    const transport = createFakeTransport((call) => {
      if (call.url.endsWith('/.env')) {
        return failure === 'transport-error' ? new ScanTransportError('timeout', 'The file timed out.') : textResponse('', { status: 500 });
      }
      return call.url === 'https://example.com/' ? textResponse('<p>hello</p>') : textResponse('', { status: 404 });
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ checks: { ...EVERY_CHECK_OFF, files: true } }), deps);

    expect(result.status).toBe('completed');
    expect(result.coverage.some((row) => row.checkId === 'files' && row.reason === 'target_error')).toBe(true);
    expect(result.partialCoverage).toBe(true);
  });

  it('runs the six catalogue checks', async () => {
    const transport = createFakeTransport(() => textResponse('<p>hello</p>'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const checks = new Set(result.coverage.map((row) => row.checkId));
    expect(checks).toEqual(
      new Set(['headers', 'cookies', 'transport', 'disclosure', 'files', 'active']),
    );
    expect(result.findings.some((finding) => finding.issueId === 'missing-strict-transport-security')).toBe(true);
    expect(result.partialCoverage).toBe(false);
  });

  it('keeps one row per target and check, even though the checks publish twice', async () => {
    const transport = createFakeTransport(() => textResponse('<p>hello</p>'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const keys = result.coverage.map(
      (row) => `${row.targetKey}|${row.checkId}|${row.outcome}|${row.evaluatedIssueIds.join(',')}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const occurrences = result.findings.map((finding) => finding.occurrenceKey);
    expect(new Set(occurrences).size).toBe(occurrences.length);
  });

  it('does not run a check that is switched off', async () => {
    const transport = createFakeTransport(() => textResponse('<p>hello</p>'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ checks: { ...EVERY_CHECK_OFF, headers: true } }), deps);

    const rows = result.coverage.filter((row) => row.checkId === 'files');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.reason === 'disabled')).toBe(true);
    expect(result.findings.some((finding) => finding.checkId === 'files')).toBe(false);
    // No file of the site was requested.
    expect(requestedUrls(transport.calls).some((url) => url.includes('/.env'))).toBe(false);
  });

  it('keeps the findings of the checks that finished before the scan stopped', async () => {
    const transport = createFakeTransport(() => textResponse('<p>hello</p>'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ limits: createLimits({ maxRequests: 3 }) }), deps);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('request_limit');
    }
    expect(
      result.findings.some((finding) => finding.issueId === 'missing-strict-transport-security'),
    ).toBe(true);
    expect(result.partialCoverage).toBe(true);
  });

  it('evaluates the headers of a redirect whose destination was denied', async () => {
    const transport = createFakeTransport(() =>
      textResponse('', { status: 302, headers: { location: 'https://example.com/login' } }),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const headerRow = result.coverage.find(
      (row) => row.checkId === 'headers' && row.outcome === 'checked',
    );
    expect(headerRow?.evaluatedIssueIds).toContain('missing-strict-transport-security');
    const disclosureRow = result.coverage.find(
      (row) => row.checkId === 'disclosure' && row.outcome === 'checked',
    );
    // The body was never reached, so the body issue stays unchecked.
    expect(disclosureRow?.evaluatedIssueIds).not.toContain('stack-trace-disclosure');
  });

  it('sends the baseline and the two probes of an opted-in link', async () => {
    const transport = createFakeTransport((call) =>
      call.url.includes('/search')
        ? textResponse('<p>results</p>')
        : textResponse('<a href="/search?q=books">search</a>'),
    );
    const { deps } = createDependencies(transport);
    const scope = createScope({
      parameterizedPaths: [{ path: '/search', parameters: ['q'] }],
      activePaths: [{ path: '/search', parameters: ['q'] }],
    });

    const result = await runScan(input({ scope }), deps);

    const searchCalls = transport.calls.filter((call) => call.url.includes('/search'));
    expect(searchCalls).toHaveLength(3);
    expect(result.findings.some((finding) => finding.checkId === 'active')).toBe(false);
  });

  it('keeps the SQL finding when the request cap stops the next probe', async () => {
    const transport = createFakeTransport((call) => {
      if (call.url === 'https://example.com/') {
        return textResponse('<a href="/search?q=books">search</a>');
      }
      if (call.url.includes('%27')) {
        return textResponse('You have an error in your SQL syntax near "books\'');
      }
      return textResponse('<p>results</p>');
    });
    const { deps } = createDependencies(transport);
    const scope = createScope({
      parameterizedPaths: [{ path: '/search', parameters: ['q'] }],
      activePaths: [{ path: '/search', parameters: ['q'] }],
    });

    const result = await runScan(
      input({
        checks: { ...EVERY_CHECK_OFF, active: true },
        limits: createLimits({ maxRequests: 3 }),
        scope,
      }),
      deps,
    );

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('request_limit');
    }
    expect(result.findings.some((finding) => finding.issueId === 'sql-error-indicator')).toBe(true);
    expect(result.partialCoverage).toBe(true);
  });

  it('probes one link when the query names arrive in another order', async () => {
    const transport = createFakeTransport((call) =>
      call.url === 'https://example.com/'
        ? textResponse(
            '<a href="/search?a=1&amp;b=2">one</a><a href="/search?b=2&amp;a=1">two</a>',
          )
        : textResponse('<p>results</p>'),
    );
    const { deps } = createDependencies(transport);
    const scope = createScope({
      parameterizedPaths: [{ path: '/search', parameters: ['a', 'b'] }],
      activePaths: [{ path: '/search', parameters: ['a', 'b'] }],
    });

    const result = await runScan(input({ scope }), deps);

    // One baseline and two probes for the two links, not two of each.
    const searchCalls = transport.calls.filter((call) => call.url.includes('/search'));
    expect(searchCalls).toHaveLength(3);
    const activeRows = result.coverage.filter((row) => row.checkId === 'active');
    const linkRows = activeRows.filter((row) => row.evaluatedIssueIds.includes('sql-error-indicator'));
    expect(linkRows).toHaveLength(1);
    // The coverage names the subject it covers: the sorted first parameter.
    expect(linkRows[0]?.subjectScope).toEqual({ kind: 'restricted', subjects: ['a'] });
  });

  it('covers a file the site does not serve as a negative', async () => {
    const transport = createFakeTransport((call) =>
      call.url.endsWith('/.env')
        ? textResponse('', { status: 404 })
        : textResponse('<p>hello</p>'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const row = result.coverage.find((candidate) =>
      candidate.evaluatedIssueIds.includes('env-file-exposed'),
    );
    expect(row?.outcome).toBe('checked');
    expect(result.findings.some((finding) => finding.issueId === 'env-file-exposed')).toBe(false);
  });

  it('leaves the cleartext issue unchecked when the port refused the connection', async () => {
    const transport = createFakeTransport((call) => {
      if (call.url.startsWith('http://')) {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:80');
        Object.assign(error, { code: 'ECONNREFUSED' });
        return error;
      }
      return textResponse('<p>hello</p>');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const row = result.coverage.find((candidate) =>
      candidate.evaluatedIssueIds.includes('http-served-without-redirect'),
    );
    expect(row?.outcome).toBe('checked');
    expect(result.findings.some((finding) => finding.issueId === 'http-served-without-redirect')).toBe(
      false,
    );
  });

  it('requests a source map of a discovered script and nothing else', async () => {
    const transport = createFakeTransport((call) =>
      call.url.endsWith('/assets/app.js.map')
        ? textResponse(JSON.stringify({ version: 3, sources: ['app.ts'] }), {
            headers: { 'content-type': 'application/json' },
          })
        : textResponse('<script src="/assets/app.js"></script>'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const urls = requestedUrls(transport.calls);
    expect(urls).toContain('https://example.com/assets/app.js.map');
    expect(urls.some((url) => url.endsWith('.map') && !url.includes('/assets/app.js.map'))).toBe(false);
    expect(result.findings.some((finding) => finding.issueId === 'source-map-exposed')).toBe(true);
  });

  it('keeps every secret of the site out of the result', async () => {
    const secrets = [
      'SECRET-QUERY-VALUE',
      'SECRET-COOKIE-VALUE',
      'SECRET-DYNAMIC-PATH',
      'SECRET-CSP-NONCE',
      'SECRET-STACK-PATH',
      'SECRET-ENV-VALUE',
      'SECRET-HEADER-VALUE',
    ];
    const transport = createFakeTransport((call) => {
      if (call.url.endsWith('/.env')) {
        return textResponse('SECRET_ENV_VALUE=1\n', {
          headers: { 'content-type': 'text/plain' },
        });
      }
      return textResponse(
        [
          '<a href="/docs/a?token=SECRET-QUERY-VALUE">query</a>',
          '<a href="/docs/SECRET-DYNAMIC-PATH">dynamic</a>',
          '<script src="http://cdn.example.org/app.js"></script>',
        ].join(''),
        {
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'session=SECRET-COOKIE-VALUE; Path=/',
            'content-security-policy': "script-src 'nonce-SECRET-CSP-NONCE'",
            'x-custom-header': 'SECRET-HEADER-VALUE',
          },
        },
      );
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const serialized = JSON.stringify(result);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });
});

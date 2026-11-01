import { describe, expect, it } from 'vitest';

import { ScanTransportError } from '../errors.js';
import { evaluateFiles } from './files.js';
import {
  createCheckContext,
  createFakeRequester,
  createTarget,
  type FakeRequester,
  type RecordedRequest,
} from './check.fixtures.js';

const BASE = 'https://example.com/';

/** A requester that answers every file path from a script. */
function fileRequester(answers: Record<string, Response>): FakeRequester {
  return createFakeRequester((call: RecordedRequest) => {
    if (call.kind !== 'file') {
      return new Response('');
    }
    return answers[call.value] ?? new Response('', { status: 404 });
  });
}

function findingFor(
  results: readonly { findings: readonly { issueId: string }[] }[],
  issueId: string,
): { issueId: string } | undefined {
  return results.flatMap((result) => result.findings).find((finding) => finding.issueId === issueId);
}

describe('the exposed-file check', () => {
  it.each([
    ['/.env', 'env-file-exposed'],
    ['/.git/HEAD', 'git-head-exposed'],
    ['/server-status', 'server-status-exposed'],
    ['/app.js.map', 'source-map-exposed'],
  ])('does not treat generic text at %s as a file signature', async (path, issueId) => {
    const requester = fileRequester({ [path]: new Response('Not Found', { headers: { 'content-type': 'text/plain' } }) });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE, body: '<script src="/app.js"></script>' })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    expect(findingFor(results, issueId)).toBeUndefined();
  });

  it('confirms an environment file that matches the signature', async () => {
    const requester = fileRequester({
      '/.env': new Response('DATABASE_URL=postgres://user:pw@host/db\nSECRET_KEY=abc\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const finding = findingFor(results, 'env-file-exposed');
    expect(finding).toBeDefined();
    const full = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'env-file-exposed',
    );
    expect(full?.validation).toBe('Confirmed');
    expect(full?.severity).toBe('critical');
    expect(full?.safeLocation).toBe('https://example.com/.env');
    expect(full?.evidence).toMatchObject({
      status: 200,
      content_type: 'text',
      signature: 'env-assignments',
    });
    expect(String(full?.evidence?.digest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the body of an exposed file out of the finding', async () => {
    const requester = fileRequester({
      '/.env': new Response('DATABASE_URL=postgres://user:s3cret-password@host/db\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('s3cret-password');
    expect(serialized).not.toContain('DATABASE_URL');
  });

  it('does not call a generic page an exposed environment file', async () => {
    const requester = fileRequester({
      '/.env': new Response('<!doctype html><html><body><h1>Login</h1></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
      '/.git/HEAD': new Response('<!doctype html><html><body>Not found</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    expect(findingFor(results, 'env-file-exposed')).toBeUndefined();
    expect(findingFor(results, 'git-head-exposed')).toBeUndefined();
  });

  it('confirms a git metadata file', async () => {
    const requester = fileRequester({
      '/.git/HEAD': new Response('ref: refs/heads/main\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'git-head-exposed',
    );
    expect(finding?.validation).toBe('Confirmed');
    expect(finding?.evidence?.signature).toBe('git-head-ref');
  });

  it('confirms a server status page', async () => {
    const requester = fileRequester({
      '/server-status': new Response('Apache Server Status for example.com\nTotal accesses: 3\n', {
        headers: { 'content-type': 'text/html' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'server-status-exposed',
    );
    expect(finding?.validation).toBe('Confirmed');
    expect(finding?.evidence?.signature).toBe('apache-server-status');
  });

  it('confirms an administration page', async () => {
    const requester = fileRequester({
      '/admin/': new Response(
        '<html><body><form><input type="password" name="pw"></form></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'admin-panel-exposed',
    );
    expect(finding?.validation).toBe('Confirmed');
    expect(finding?.evidence?.signature).toBe('admin-interface');
  });

  it('reports the information files of the site as informational', async () => {
    const requester = fileRequester({
      '/robots.txt': new Response('User-agent: *\nDisallow: /admin\n', {
        headers: { 'content-type': 'text/plain' },
      }),
      '/security.txt': new Response('Contact: mailto:security@example.com\nExpires: 2030-01-01\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const findings = results.flatMap((result) => result.findings);
    const robots = findings.find((candidate) => candidate.issueId === 'robots-txt-present');
    const security = findings.find((candidate) => candidate.issueId === 'security-txt-present');
    expect(robots?.validation).toBe('Informational');
    expect(robots?.severity).toBe('info');
    expect(security?.validation).toBe('Informational');
  });

  it('never claims more than a weaker indication', async () => {
    const requester = fileRequester({
      '/.env': new Response('export greeting=hello', { headers: { 'content-type': 'text/plain' } }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'env-file-exposed',
    );
    expect(finding?.validation).toBe('Likely');
    expect(finding?.evidence?.signature).toBe('env-text');
  });

  it('covers a guarded file as a negative when the site refuses it', async () => {
    const requester = fileRequester({
      '/.env': new Response('', { status: 403 }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const row = results.find((result) =>
      result.coverage.evaluatedIssueIds.includes('env-file-exposed'),
    );
    expect(row?.coverage.outcome).toBe('checked');
    expect(row?.findings).toEqual([]);
  });

  it.each(['/static/.env', '/static/%2eenv', '/static%2f.env', '/static/%zz'])('proves nothing for a same-file or unparseable redirect: %s', async (location) => {
    const requester = fileRequester({
      '/.env': new Response('', { status: 302, headers: { location } }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const row = results.find((result) => result.coverage.reason === 'redirect_out_of_scope');
    expect(row?.coverage.outcome).toBe('not-visited');
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('proves the file is not served when a redirect goes to another route', async () => {
    const requester = fileRequester({
      '/.env': new Response('', { status: 302, headers: { location: '/login' } }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const row = results.find((result) =>
      result.coverage.evaluatedIssueIds.includes('env-file-exposed'),
    );
    expect(row?.coverage.outcome).toBe('checked');
    expect(row?.findings).toEqual([]);
  });

  it('leaves a file unchecked when the site answers with a server error', async () => {
    const requester = fileRequester({
      '/.env': new Response('', { status: 500 }),
    });
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const row = results.find((result) => result.coverage.reason === 'target_error');
    expect(row?.coverage.outcome).toBe('not-visited');
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('leaves a file unchecked when the request did not answer', async () => {
    const requester = createFakeRequester(
      (call: RecordedRequest) =>
        call.kind === 'file'
          ? new ScanTransportError('reset', 'the connection was reset')
          : new Response(''),
    );
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const row = results.find((result) => result.coverage.outcome === 'error');
    expect(row?.coverage.reason).toBe('target_error');
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('requests every file with a GET and never with a HEAD', async () => {
    const requester = fileRequester({});
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    await evaluateFiles(context);

    expect(requester.calls.filter((call) => call.kind === 'file').length).toBe(6);
  });

  it('requests a source map that belongs to a discovered script', async () => {
    const requester = fileRequester({
      '/assets/app.js.map': new Response(
        JSON.stringify({ version: 3, sources: ['app.ts'], sourcesContent: ['secret source'] }),
        { headers: { 'content-type': 'application/json' } },
      ),
    });
    const context = createCheckContext({
      targets: [
        createTarget({ url: BASE, body: '<script src="/assets/app.js"></script>' }),
      ],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    expect(requester.calls.map((call) => call.value)).toContain('/assets/app.js.map');
    const finding = findingFor(results, 'source-map-exposed');
    expect(finding).toBeDefined();
    expect(JSON.stringify(results)).not.toContain('secret source');
  });

  it('requests a configured extra path and skips an invalid one', async () => {
    const requester = fileRequester({
      '/internal/notes.txt': new Response('notes', { headers: { 'content-type': 'text/plain' } }),
    });
    const context = createCheckContext({
      scope: { extraFilePaths: ['/internal/notes.txt', '/../escape.txt'] },
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateFiles(context);

    const requested = requester.calls.filter((call) => call.kind === 'file').map((call) => call.value);
    expect(requested).toContain('/internal/notes.txt');
    expect(requested).not.toContain('/../escape.txt');
    expect(findingFor(results, 'extra-file-exposed')).toBeDefined();
  });
});

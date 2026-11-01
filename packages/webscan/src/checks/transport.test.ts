import { describe, expect, it } from 'vitest';

import { ScanTransportError } from '../errors.js';
import { targetKeyOf } from '../test-support.fixtures.js';
import { evaluateTransport } from './transport.js';
import {
  createCheckContext,
  createFakeRequester,
  createTarget,
  type RecordedRequest,
} from './check.fixtures.js';

const BASE = 'https://example.com/';
const PROBE_KEY = targetKeyOf('http://example.com/');

function probeRow(results: readonly { coverage: { targetKey: string } }[]) {
  return results.find((result) => result.coverage.targetKey === PROBE_KEY);
}

describe('the transport check', () => {
  it('reports a site that answers on port 80 without redirecting', async () => {
    const requester = createFakeRequester(() => new Response('hello', { status: 200 }));
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    const finding = probeRow(results)?.findings[0];
    expect(finding?.issueId).toBe('http-served-without-redirect');
    expect(finding?.validation).toBe('Confirmed');
    expect(finding?.evidence).toEqual({ status: 200, redirected_to_https: false });
    expect(probeRow(results)?.coverage.outcome).toBe('checked');
  });

  it('accepts a cleartext port that redirects to HTTPS', async () => {
    const requester = createFakeRequester(
      () => new Response('', { status: 301, headers: { location: 'https://example.com/' } }),
    );
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    expect(probeRow(results)?.coverage.outcome).toBe('checked');
    expect(probeRow(results)?.coverage.evaluatedIssueIds).toEqual([
      'http-served-without-redirect',
    ]);
    expect(probeRow(results)?.findings).toEqual([]);
  });

  it('probes the root of the site without the base path', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      scope: { baseUrl: 'https://example.com/secret-base' },
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    await evaluateTransport(context);

    const probe = requester.calls.find((call) => call.kind === 'probe');
    expect(probe?.value).toBe('http://example.com/');
  });

  it('treats a refused cleartext port as a negative when the secure port answered', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'probe'
        ? new ScanTransportError('refused', 'the port refused the connection')
        : new Response(''),
    );
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    expect(probeRow(results)?.coverage.outcome).toBe('checked');
    expect(probeRow(results)?.coverage.reason).toBeUndefined();
    expect(probeRow(results)?.coverage.evaluatedIssueIds).toEqual([
      'http-served-without-redirect',
    ]);
    expect(probeRow(results)?.findings).toEqual([]);
  });

  it('leaves the issue unchecked when the secure port never answered', async () => {
    const requester = createFakeRequester(
      () => new ScanTransportError('refused', 'the port refused the connection'),
    );
    const context = createCheckContext({
      targets: [createTarget({ url: BASE, destinationReached: false })],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    expect(probeRow(results)?.coverage.outcome).toBe('not-visited');
    expect(probeRow(results)?.coverage.reason).toBe('http_probe_unreachable');
    expect(probeRow(results)?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('leaves the issue unchecked when the cleartext port timed out', async () => {
    const requester = createFakeRequester(
      () => new ScanTransportError('timeout', 'the port did not answer'),
    );
    const context = createCheckContext({
      targets: [createTarget({ url: BASE })],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    expect(probeRow(results)?.coverage.outcome).toBe('not-visited');
    expect(probeRow(results)?.coverage.reason).toBe('http_probe_unreachable');
    // The check itself still evaluated the page it read.
    const page = results.find((result) => result.coverage.targetKey !== PROBE_KEY);
    expect(page?.coverage.outcome).toBe('checked');
    expect(page?.coverage.evaluatedIssueIds).toEqual(['mixed-content']);
  });

  it('reports an HTTP asset of an HTTPS page without requesting it', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      targets: [
        createTarget({
          url: BASE,
          body: '<script src="http://cdn.example.org/app.js"></script><img src="/local.png">',
        }),
      ],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    const finding = results
      .flatMap((result) => result.findings)
      .find((candidate) => candidate.issueId === 'mixed-content');
    expect(finding?.evidence).toEqual({ scheme: 'http', asset_kinds: 'script' });
    // The third party was never requested.
    expect(requester.calls.filter((call) => call.kind !== 'probe')).toEqual([]);
  });

  it('reports nothing when every asset of the page is served over HTTPS', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      targets: [
        createTarget({
          url: BASE,
          body: '<script src="/app.js"></script><img src="https://example.com/a.png">',
        }),
      ],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    expect(
      results
        .flatMap((result) => result.findings)
        .filter((finding) => finding.issueId === 'mixed-content'),
    ).toEqual([]);
  });

  it('does not evaluate the mixed content of a redirect whose destination was denied', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      targets: [
        createTarget({
          url: BASE,
          status: 302,
          headers: { location: 'https://example.com/login' },
          body: '<script src="http://cdn.example.org/app.js"></script>',
          destinationReached: false,
        }),
      ],
      requester: requester.requester,
    });

    const results = await evaluateTransport(context);

    const page = results.find((result) => result.coverage.targetKey !== PROBE_KEY);
    expect(page?.coverage.evaluatedIssueIds).toEqual([]);
    expect(page?.findings).toEqual([]);
  });
});

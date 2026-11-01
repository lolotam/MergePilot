import { describe, expect, it } from 'vitest';

import { ScanTransportError } from '../errors.js';
import { targetKeyOf } from '../test-support.fixtures.js';
import { evaluateActive } from './active.js';
import {
  ACTIVE_LINK,
  ACTIVE_SCOPE,
  createCandidate,
  createCheckContext,
  createFakeRequester,
  createTarget,
  type RecordedRequest,
} from './check.fixtures.js';

describe('the active check', () => {
  it('reports one occurrence when a probe matches several SQL signatures', async () => {
    const requester = createFakeRequester((call: RecordedRequest) => call.kind === 'active'
      ? new Response('You have an error in your SQL syntax; mysqli_sql_exception')
      : new Response('results'));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const findings = results.flatMap((result) => result.findings).filter((finding) => finding.issueId === 'sql-error-indicator');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence?.signature).toBe('sql-syntax-error');
  });

  it('touches nothing when the site did not opt in', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    expect(requester.calls).toEqual([]);
    expect(results.flatMap((result) => result.findings)).toEqual([]);
  });

  it('sends the baseline and the two probes of an opted-in link', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    await evaluateActive(context);

    expect(requester.calls.map((call) => call.kind)).toEqual(['baseline', 'active', 'active']);
  });

  it('keeps the path, the host and the parameter names of the link', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    await evaluateActive(context);

    for (const call of requester.calls) {
      const url = new URL(call.value);
      expect(url.origin).toBe('https://example.com');
      expect(url.pathname).toBe('/search');
      expect([...url.searchParams.keys()]).toEqual(['q']);
    }
  });

  it('reports a database error that the baseline did not show', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? new Response('You have an error in your SQL syntax near "books\'')
        : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'sql-error-indicator',
    );
    expect(finding?.validation).toBe('Likely');
    expect(finding?.evidence).toEqual({ parameter: 'q', signature: 'sql-syntax-error' });
  });

  it('does not blame the probe for an error the baseline already showed', async () => {
    const requester = createFakeRequester(() =>
      new Response('You have an error in your SQL syntax near "books"'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    expect(
      results.flatMap((result) => result.findings).find(
        (candidate) => candidate.issueId === 'sql-error-indicator',
      ),
    ).toBeUndefined();
  });

  it('reports a reflected marker as an indicator only', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? new Response('<p>mpws reflect 7q</p>')
        : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const finding = results.flatMap((result) => result.findings).find(
      (candidate) => candidate.issueId === 'reflection-indicator',
    );
    expect(finding?.validation).toBe('Indicator');
    expect(finding?.evidence).toEqual({ parameter: 'q', form: 'full' });
  });

  it('keeps the marker out of the finding', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? new Response('<p>mpws reflect 7q</p>')
        : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    expect(JSON.stringify(results)).not.toContain('mpws reflect 7q');
  });

  it('names the occurrence after the baseline of the link', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active' ? new Response('mpws reflect 7q') : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const finding = results.flatMap((result) => result.findings)[0];
    expect(finding?.targetKey).toBe(
      results.find((result) => result.findings.length > 0)?.coverage.targetKey,
    );
    expect(finding?.subject).toBe('q');
  });

  it('claims no issue when a probe did not answer', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? new ScanTransportError('reset', 'the connection was reset')
        : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
    expect(row?.findings).toEqual([]);
  });

  it('records the page of the scan without claiming an issue of its own', async () => {
    const requester = createFakeRequester(() => new Response(''));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      targets: [createTarget({ url: 'https://example.com/' })],
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const page = results.find((result) => result.coverage.targetKey !== '');
    expect(page?.coverage.evaluatedIssueIds).toEqual([]);
    expect(page?.coverage.outcome).toBe('checked');
  });
});

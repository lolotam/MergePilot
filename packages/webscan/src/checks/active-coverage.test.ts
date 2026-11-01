/**
 * The coverage of the active check.
 *
 * A probe only means something when the baseline is a usable page of the link
 * and the probe answers with a usable page itself. These tests pin that rule,
 * the subject the coverage names, and the moment the proven observation is
 * published.
 */

import { describe, expect, it } from 'vitest';

import { ScanStopError, ScanTransportError } from '../errors.js';
import type { CheckEvaluation } from '../evaluation.js';
import { SITE_IDENTITY, targetKeyOf } from '../test-support.fixtures.js';
import { evaluateActive } from './active.js';
import {
  ACTIVE_LINK,
  ACTIVE_SCOPE,
  createCandidate,
  createCheckContext,
  createFakeRequester,
  type RecordedRequest,
  type RequestAnswer,
} from './check.fixtures.js';

/** The scope that opts the active check in for a link with two parameters. */
const TWO_PARAMETER_SCOPE = {
  parameterizedPaths: [{ path: '/search', parameters: ['a', 'b'] }],
  activePaths: [{ path: '/search', parameters: ['a', 'b'] }],
};

/** One answer of the baseline of a link. */
interface BaselineCase {
  readonly name: string;
  readonly answer: RequestAnswer;
  /** How many probes the check may send after this baseline. */
  readonly probes: number;
  /** The outcome the row of the link carries. */
  readonly outcome: 'checked' | 'error' | 'not-visited';
  /** Whether the check may claim an issue of the link. */
  readonly claims: boolean;
}

/** The baselines that decide whether a probe means anything. */
const BASELINE_CASES: readonly BaselineCase[] = [
  {
    name: 'a denied redirect',
    answer: { status: 302, destinationReached: false },
    probes: 0,
    outcome: 'not-visited',
    claims: false,
  },
  {
    name: 'a refusal',
    answer: { status: 403 },
    probes: 0,
    outcome: 'not-visited',
    claims: false,
  },
  {
    name: 'a server error',
    answer: { status: 500 },
    probes: 0,
    outcome: 'error',
    claims: false,
  },
  {
    name: 'a transport error',
    answer: new ScanTransportError('reset', 'the connection was reset'),
    probes: 0,
    outcome: 'error',
    claims: false,
  },
  {
    name: 'a normal page',
    answer: { status: 200 },
    probes: 2,
    outcome: 'checked',
    claims: true,
  },
];

/** One answer of a probe of a link. */
interface ProbeCase {
  readonly name: string;
  readonly answer: RequestAnswer;
  /** The outcome the row of the link carries. */
  readonly outcome: 'checked' | 'error' | 'not-visited';
  /** Whether the check may claim an issue of the link. */
  readonly claims: boolean;
}

/** The probe answers that decide whether the absence of an indicator is proven. */
const PROBE_CASES: readonly ProbeCase[] = [
  {
    name: 'a denied redirect',
    answer: { status: 302, destinationReached: false },
    outcome: 'not-visited',
    claims: false,
  },
  {
    name: 'a refusal',
    answer: { status: 403 },
    outcome: 'not-visited',
    claims: false,
  },
  {
    name: 'a server error',
    answer: { status: 500 },
    outcome: 'error',
    claims: false,
  },
  {
    name: 'a transport error',
    answer: new ScanTransportError('reset', 'the connection was reset'),
    outcome: 'error',
    claims: false,
  },
  {
    name: 'a normal page',
    answer: { status: 200 },
    outcome: 'checked',
    claims: true,
  },
];

describe('the coverage of the active check', () => {
  it.each(BASELINE_CASES)('sends no probe when the baseline is $name', async (testCase) => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'baseline' ? testCase.answer : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    expect(requester.calls.filter((call) => call.kind === 'active')).toHaveLength(testCase.probes);
    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.outcome).toBe(testCase.outcome);
    expect(row?.coverage.evaluatedIssueIds.length > 0).toBe(testCase.claims);
  });

  it.each(PROBE_CASES)('claims no issue when the probe is $name', async (testCase) => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active' ? testCase.answer : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.outcome).toBe(testCase.outcome);
    expect(row?.coverage.evaluatedIssueIds).toEqual(
      testCase.claims ? ['sql-error-indicator', 'reflection-indicator'] : [],
    );
    expect(row?.findings).toEqual([]);
  });

  it('never attributes the body of a denied destination to the link', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? {
            status: 302,
            destinationReached: false,
            body: 'mpws reflect 7q You have an error in your SQL syntax',
          }
        : new Response('results'),
    );
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.findings).toEqual([]);
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('reports the database error of a server error but claims no negative coverage', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? { status: 500, body: 'You have an error in your SQL syntax near "books\'' }
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
    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
    expect(row?.coverage.outcome).toBe('error');
  });

  it('reports the reflected marker of a server error but claims no negative coverage', async () => {
    const requester = createFakeRequester((call: RecordedRequest) =>
      call.kind === 'active'
        ? { status: 500, body: '<p>mpws reflect 7q</p>' }
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
    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.evaluatedIssueIds).toEqual([]);
  });

  it('probes the same parameter whatever the order of the query names', async () => {
    const probed: string[] = [];

    for (const link of ['https://example.com/search?a=1&b=2', 'https://example.com/search?b=2&a=1']) {
      probed.length = 0;
      // The crawler names the parameters of a link in the order of the query.
      const names = [...new URL(link).searchParams.keys()];
      const requester = createFakeRequester((call: RecordedRequest) => {
        if (call.kind === 'active') {
          const url = new URL(call.value);
          probed.push(
            [...url.searchParams.entries()].find(([, value]) => value !== '1' && value !== '2')?.[0] ?? '',
          );
        }
        return new Response('results');
      });
      const context = createCheckContext({
        scope: TWO_PARAMETER_SCOPE,
        candidates: [createCandidate(link, names)],
        requester: requester.requester,
      });

      await evaluateActive(context);

      expect(probed).toEqual(['a', 'a']);
    }
  });

  it('keeps one occurrence for two links that differ only in the order of their query names', async () => {
    const first = 'https://example.com/search?a=1&b=2';
    const second = 'https://example.com/search?b=2&a=1';
    // The app computes one identity for both links: they are one target.
    expect(SITE_IDENTITY.identifyTarget(first)).toBe(SITE_IDENTITY.identifyTarget(second));
    const requester = createFakeRequester(() => new Response('results'));
    const context = createCheckContext({
      scope: TWO_PARAMETER_SCOPE,
      candidates: [
        createCandidate(first, ['a', 'b'], SITE_IDENTITY.identifyTarget(first)),
        createCandidate(second, ['b', 'a'], SITE_IDENTITY.identifyTarget(second)),
      ],
      requester: requester.requester,
      identity: SITE_IDENTITY,
    });

    const results = await evaluateActive(context);

    // One baseline and two probes, not two of each.
    expect(requester.calls.map((call) => call.kind)).toEqual(['baseline', 'active', 'active']);
    const rows = results.filter(
      (result) => result.coverage.targetKey === SITE_IDENTITY.identifyTarget(first),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.coverage.subjectScope).toEqual({ kind: 'restricted', subjects: ['a'] });
  });

  it('names the subject of the active coverage and never the whole target', async () => {
    const requester = createFakeRequester(() => new Response('results'));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(row?.coverage.subjectScope).toEqual({ kind: 'restricted', subjects: ['q'] });
    expect(row?.coverage.subjectScope).not.toEqual({ kind: 'complete' });
  });

  it('keeps the query value out of the coverage scope', async () => {
    const requester = createFakeRequester(() => new Response('results'));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
    });

    const results = await evaluateActive(context);

    const row = results.find((result) => result.coverage.targetKey === targetKeyOf(ACTIVE_LINK));
    expect(JSON.stringify(row?.coverage)).not.toContain('books');
  });

  it('keeps the order of the repeated values of a parameter', async () => {
    const requester = createFakeRequester(() => new Response('results'));
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate('https://example.com/search?q=1&q=2', ['q'])],
      requester: requester.requester,
    });

    await evaluateActive(context);

    const probe = new URL(requester.calls.find((call) => call.kind === 'active')?.value ?? '');
    expect([...probe.searchParams.entries()]).toEqual([
      ['q', "1'"],
      ['q', '2'],
    ]);
  });

  it('publishes the SQL observation before the reflection probe starts', async () => {
    const events: string[] = [];
    const requester = createFakeRequester((call: RecordedRequest) => {
      if (call.kind !== 'active') {
        events.push('baseline');
        return new Response('results');
      }
      const sqlProbe = call.value.includes('%27');
      events.push(sqlProbe ? 'sql-probe' : 'reflection-probe');
      return sqlProbe ? new Response('You have an error in your SQL syntax') : new Response('results');
    });
    const context = createCheckContext({
      scope: ACTIVE_SCOPE,
      candidates: [createCandidate(ACTIVE_LINK, ['q'])],
      requester: requester.requester,
      emit: () => {
        events.push('publish');
      },
    });

    await evaluateActive(context);

    expect(events).toEqual(['baseline', 'sql-probe', 'publish', 'reflection-probe', 'publish']);
  });

  it.each(['request_limit', 'time_limit', 'cancelled'] as const)(
    'keeps the SQL finding when the reflection probe stops the scan with %s',
    async (reason) => {
      const published: CheckEvaluation[] = [];
      const requester = createFakeRequester((call: RecordedRequest) => {
        if (call.kind !== 'active') {
          return new Response('results');
        }
        if (call.value.includes('%27')) {
          return new Response('You have an error in your SQL syntax');
        }
        throw new ScanStopError(reason, 'the scan stopped');
      });
      const context = createCheckContext({
        scope: ACTIVE_SCOPE,
        candidates: [createCandidate(ACTIVE_LINK, ['q'])],
        requester: requester.requester,
        emit: (batch) => published.push(...batch),
      });

      await expect(evaluateActive(context)).rejects.toThrow(ScanStopError);

      const finding = published.flatMap((evaluation) => evaluation.findings).find(
        (candidate) => candidate.issueId === 'sql-error-indicator',
      );
      expect(finding?.validation).toBe('Likely');
      const row = published.find(
        (evaluation) => evaluation.coverage.targetKey === targetKeyOf(ACTIVE_LINK),
      );
      expect(row?.coverage.evaluatedIssueIds).toEqual(['sql-error-indicator']);
    },
  );
});

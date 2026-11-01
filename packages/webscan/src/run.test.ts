import { describe, expect, it } from 'vitest';

import {
  CHECK_IDS,
  NO_CHECK_EVALUATOR,
  coverageReasonForTargetError,
  type CheckEvaluation,
  type CheckEvaluator,
} from './evaluation.js';
import { runScan, runScanWithEvaluator } from './run.js';
import {
  createDependencies,
  createFakeClock,
  createFakeTransport,
  createLimits,
  createScope,
  redirectResponse,
  targetKeyOf,
  textResponse,
} from './test-support.fixtures.js';
import type { CheckSwitches, ScanInput, ScanObservation } from './types.js';

const BASE = 'https://example.com/';

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

describe('a scan that reaches its end', () => {
  it('claims no coverage while no check is implemented', async () => {
    const transport = createFakeTransport(() => textResponse('<a href="/docs/a">a</a>'));
    const { deps } = createDependencies(transport);

    const result = await runScanWithEvaluator(input(), deps, NO_CHECK_EVALUATOR);

    expect(result.status).toBe('completed');
    expect(result.findings).toEqual([]);
    expect(result.coverage).toEqual([]);
  });

  it('reports partial coverage while an enabled check evaluated nothing', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const evaluator: CheckEvaluator = { evaluate: async () => [] };

    const result = await runScanWithEvaluator(input(), deps, evaluator);

    expect(result.status).toBe('completed');
    expect(result.partialCoverage).toBe(true);
  });

  it('counts the requests and the pages it made', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a">a</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ checks: EVERY_CHECK_OFF }), deps);

    expect(result.requests).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the raw URL and the query values out of the result', async () => {
    const transport = createFakeTransport(() =>
      textResponse('<a href="/docs/a?token=s3cret">a</a>'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('token=s3cret');
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('https://example.com/?token=s3cret');
  });

  it('reports the progress as counts only', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps, progress } = createDependencies(transport);

    await runScan(input(), deps);

    expect(progress.length).toBeGreaterThan(0);
    for (const event of progress) {
      expect(Number.isInteger(event.requests)).toBe(true);
      expect(Number.isInteger(event.pages)).toBe(true);
      expect(['crawl', 'checks', 'complete']).toContain(event.phase);
    }
  });
});

describe('a scan that meets a wall', () => {
  it.each([
    'not-a-url',
    'https://example.com:8443/',
    'https://user:pw@example.com/',
  ])('fails a malformed or forbidden base target without claiming coverage: %s', async (baseUrl) => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ scope: createScope({ baseUrl }) }), deps);

    expect(result).toMatchObject({ status: 'failed', reason: 'policy_violation', partialCoverage: true });
    expect(result.coverage).toEqual([]);
    expect(transport.calls).toHaveLength(0);
  });

  it('does not fail when a redirect leaves the scope', async () => {
    const transport = createFakeTransport(() => redirectResponse('https://example.com/admin'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('completed');
    expect(result.pages).toBe(1);
  });

  it('stops when the request budget is exhausted', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a">a</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ limits: createLimits({ maxRequests: 1 }) }), deps);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('request_limit');
    }
    expect(transport.calls).toHaveLength(1);
  });

  it('stops when the scan was cancelled', async () => {
    const controller = new AbortController();
    const transport = createFakeTransport((call) => {
      if (call.url === BASE) {
        controller.abort();
        return textResponse('<a href="/docs/a">a</a>');
      }
      return textResponse('ok');
    });
    const { deps } = createDependencies(transport, { signal: controller.signal });

    const result = await runScan(input(), deps);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('cancelled');
    }
    expect(transport.calls).toHaveLength(1);
  });

  it('fails when the site itself could not be read', async () => {
    const transport = createFakeTransport(() => new Error('connection reset'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('transport_error');
    }
  });

  it('still evaluates the pages it did read when the scan stopped', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a">a</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let seen = 0;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        seen = context.targets.length;
        return [];
      },
    };

    const result = await runScanWithEvaluator(
      input({ limits: createLimits({ maxRequests: 1 }) }),
      deps,
      evaluator,
    );

    expect(result.status).toBe('stopped');
    expect(seen).toBe(1);
  });

  it('does not evaluate anything when the scan failed', async () => {
    const transport = createFakeTransport(() => new Error('connection reset'));
    const { deps } = createDependencies(transport);
    let seen = -1;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        seen = context.targets.length;
        return [];
      },
    };

    const result = await runScanWithEvaluator(input(), deps, evaluator);

    expect(result.status).toBe('failed');
    expect(seen).toBe(-1);
  });

  it('fails before it sends anything when the contact cannot be used as a header', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ contact: 'ops@example.com\r\nX-Injected: 1' }), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('policy_violation');
    }
    expect(transport.calls).toHaveLength(0);
  });

  it('fails when the scope is violated before anything is sent', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);

    const result = await runScan(input({ scope: createScope({ hostname: 'other.example.com' }) }), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('policy_violation');
    }
  });
});

describe('the check seam', () => {
  it('hands the pages it read to the evaluator', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a">a</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let seen = 0;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        seen = context.targets.length;
        return [];
      },
    };

    await runScanWithEvaluator(input(), deps, evaluator);

    expect(seen).toBe(2);
  });

  it('returns the findings and the coverage the evaluator produced', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const targetKey = targetKeyOf(BASE);
    const evaluator: CheckEvaluator = {
      evaluate: async (): Promise<readonly CheckEvaluation[]> =>
        CHECK_IDS.map((checkId) => ({
          coverage: {
            targetKey,
            checkId,
            checkVersion: 1,
            evaluatedIssueIds: [`${checkId}-issue`],
            outcome: 'checked' as const,
          },
          findings:
            checkId === 'headers'
              ? [
                  {
                    occurrenceKey: 'occurrence-1',
                    targetKey,
                    checkId: 'headers' as const,
                    checkVersion: 1,
                    issueKey: 'headers|missing-hsts|example.com',
                    issueId: 'missing-hsts',
                    subject: 'strict-transport-security',
                    severity: 'medium' as const,
                    validation: 'Confirmed' as const,
                    confidence: 'high' as const,
                    safeLocation: 'https://example.com/',
                    evidenceHash: 'hash-1',
                    evidence: { header: 'strict-transport-security' },
                  },
                ]
              : [],
        })),
    };

    const result = await runScanWithEvaluator(input(), deps, evaluator);

    expect(result.findings).toHaveLength(1);
    expect(result.coverage).toHaveLength(CHECK_IDS.length);
    expect(result.coverage[0]?.outcome).toBe('checked');
    expect(result.partialCoverage).toBe(false);
  });

  it('records an error row for a target it could not read', async () => {
    const transport = createFakeTransport((call) => {
      if (call.url === BASE) {
        return new Error('connection reset');
      }
      return textResponse('ok');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.coverage.length).toBeGreaterThan(0);
    const row = result.coverage[0];
    expect(row?.outcome).toBe('error');
    expect(row?.reason).toBe('target_error');
    expect(row?.evaluatedIssueIds).toEqual([]);
  });

  it('merges the coverage rows of one target and one subject scope', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const targetKey = targetKeyOf(BASE);
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        context.emit([
          {
            coverage: {
              targetKey,
              checkId: 'active',
              checkVersion: 1,
              evaluatedIssueIds: ['sql-error-indicator'],
              outcome: 'checked' as const,
              subjectScope: { kind: 'restricted', subjects: ['q'] },
            },
            findings: [],
          },
        ]);
        return [
          {
            coverage: {
              targetKey,
              checkId: 'active',
              checkVersion: 1,
              evaluatedIssueIds: ['sql-error-indicator', 'reflection-indicator'],
              outcome: 'checked' as const,
              subjectScope: { kind: 'restricted', subjects: ['q'] },
            },
            findings: [],
          },
        ];
      },
    };

    const result = await runScanWithEvaluator(input(), deps, evaluator);

    const activeRows = result.coverage.filter((row) => row.checkId === 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.evaluatedIssueIds).toEqual([
      'sql-error-indicator',
      'reflection-indicator',
    ]);
  });

  it('keeps coverage rows of different subject scopes apart', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const targetKey = targetKeyOf(BASE);
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        context.emit([
          {
            coverage: {
              targetKey,
              checkId: 'active',
              checkVersion: 1,
              evaluatedIssueIds: ['sql-error-indicator'],
              outcome: 'checked' as const,
              subjectScope: { kind: 'restricted', subjects: ['a'] },
            },
            findings: [],
          },
        ]);
        return [
          {
            coverage: {
              targetKey,
              checkId: 'active',
              checkVersion: 1,
              evaluatedIssueIds: ['sql-error-indicator'],
              outcome: 'checked' as const,
              subjectScope: { kind: 'restricted', subjects: ['b'] },
            },
            findings: [],
          },
        ];
      },
    };

    const result = await runScanWithEvaluator(input(), deps, evaluator);

    const activeRows = result.coverage.filter((row) => row.checkId === 'active');
    expect(activeRows).toHaveLength(2);
    expect(activeRows.map((row) => row.subjectScope)).toEqual([
      { kind: 'restricted', subjects: ['a'] },
      { kind: 'restricted', subjects: ['b'] },
    ]);
  });
});

describe('the coverage reason of a target that could not be read', () => {
  it('keeps the outcome of the cleartext probe inside the check', () => {
    expect(coverageReasonForTargetError('transport-probe')).toBe('http_probe_unreachable');
  });

  it('reports an ordinary target as a target error', () => {
    expect(coverageReasonForTargetError('crawl')).toBe('target_error');
    expect(coverageReasonForTargetError('explicit')).toBe('target_error');
  });
});

describe('the counters of a stopped scan', () => {  it('keeps the pages it did read', async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport, { clock });

    const result: ScanObservation = await runScan(
      input({ limits: createLimits({ maxRequests: 2, totalTimeoutMs: 1000 }) }),
      deps,
    );

    expect(result.requests).toBeLessThanOrEqual(2);
    expect(result.pages).toBeLessThanOrEqual(2);
  });
});

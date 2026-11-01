import { describe, expect, it } from 'vitest';

import { ScanPolicyError, ScanStopError } from './errors.js';
import type { CheckEvaluationContext, CheckEvaluator } from './evaluation.js';
import { runScanWithEvaluator } from './run.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  targetKeyOf,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput, ScanScope } from './types.js';

const BASE = 'https://example.com/';

function input(scope: ScanScope, overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    scope,
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

/** The scope the tests narrow. */
function scopeWithParameter(overrides: Partial<ScanScope> = {}): ScanScope {
  return createScope({
    parameterizedPaths: [{ path: '/docs/a', parameters: ['id'] }],
    activePaths: [{ path: '/docs/a', parameters: ['id'] }],
    ...overrides,
  });
}

describe('the request capability of a check', () => {
  it('spends the budget of the scan', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    let seen = 0;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        await context.request.getFixedFile('/.env');
        seen = context.request ? 1 : 0;
        return [];
      },
    };

    const result = await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(seen).toBe(1);
    expect(result.requests).toBe(2);
    expect(transport.calls.map((call) => call.url)).toEqual([
      BASE,
      'https://example.com/.env',
    ]);
  });

  it('probes the fixed root over cleartext and nothing else', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        await context.request.probeRootPort80();
        return [];
      },
    };

    await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(transport.calls.map((call) => call.url)).toEqual([
      BASE,
      'http://example.com/',
    ]);
  });

  it('reads the baseline of an authorized parameterized link', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a?id=1">one</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let candidate: { url: string; path: string } | undefined;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        candidate = context.candidates[0];
        await context.request.getBaseline(context.candidates[0]!);
        return [];
      },
    };

    await runScanWithEvaluator(input(scopeWithParameter({ crawlPaths: [] })), deps, evaluator);

    expect(candidate?.url).toBe('https://example.com/docs/a?id=1');
    expect(transport.calls.map((call) => call.url)).toEqual([
      BASE,
      'https://example.com/docs/a?id=1',
    ]);
  });

  it('probes an authorized parameterized link and refuses one that is not authorized', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a?id=1">one</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let refused: unknown;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        const found = context.candidates[0]!;
        await context.request.probeActive(found, 'https://example.com/docs/a?id=1%27');
        refused = await context.request
          .probeActive(found, 'https://example.com/docs/a?id=1&other=2')
          .then(() => undefined)
          .catch((error: unknown) => error);
        return [];
      },
    };

    await runScanWithEvaluator(input(scopeWithParameter({ crawlPaths: [] })), deps, evaluator);

    expect(transport.calls.map((call) => call.url)).toEqual([
      BASE,
      'https://example.com/docs/a?id=1%27',
    ]);
    expect(refused).toBeInstanceOf(ScanPolicyError);
  });

  it.each(['/private/secret', '/anything.map', '/deep/secret/path.map'])('refuses an undiscovered or unauthorized fixed-file path: %s', async (path) => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    let refused: unknown;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        refused = await context.request
          .getFixedFile(path)
          .then(() => undefined)
          .catch((error: unknown) => error);
        return [];
      },
    };

    await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(refused).toBeInstanceOf(ScanPolicyError);
    expect(transport.calls.map((call) => call.url)).toEqual([BASE]);
  });

  it('makes no request after the scan stopped', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a">a</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let refused: unknown;
    const evaluator: CheckEvaluator = {
      evaluate: async (context) => {
        refused = await context.request
          .getFixedFile('/.env')
          .then(() => undefined)
          .catch((error: unknown) => error);
        return [];
      },
    };

    const result = await runScanWithEvaluator(
      input(createScope(), { limits: createLimits({ maxRequests: 1 }) }),
      deps,
      evaluator,
    );

    expect(refused).toBeInstanceOf(ScanStopError);
    expect((refused as ScanStopError).reason).toBe('request_limit');
    expect(transport.calls).toHaveLength(1);
    expect(result.status).toBe('stopped');
  });
});

describe('the context of a check', () => {
  it('hands the identity functions and the transient metadata of the targets', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    let context: CheckEvaluationContext | undefined;
    const evaluator: CheckEvaluator = {
      evaluate: async (received) => {
        context = received;
        return [];
      },
    };

    await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(context?.targets).toHaveLength(1);
    expect(context?.targets[0]?.baselineUrl).toBe(BASE);
    expect(context?.targets[0]?.finalUrl).toBe(BASE);
    expect(context?.targets[0]?.location).toBeNull();
    expect(context?.identity.identifyTarget(BASE)).toBe(targetKeyOf(BASE));
    expect(context?.identity.identifyOccurrence({
      targetKey: 't',
      checkId: 'headers',
      issueId: 'i',
      subject: 's',
    })).toContain('headers');
  });

  it('hands the location of a redirect that was not followed', async () => {
    const transport = createFakeTransport(() =>
      new Response('', { status: 302, headers: { location: 'https://example.com/login' } }),
    );
    const { deps } = createDependencies(transport);
    let context: CheckEvaluationContext | undefined;
    const evaluator: CheckEvaluator = {
      evaluate: async (received) => {
        context = received;
        return [];
      },
    };

    await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(context?.targets[0]?.location).toBe('https://example.com/login');
    expect(context?.targets[0]?.destinationReached).toBe(false);
  });

  it('hands only the authorized parameterized links, bounded', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE
        ? textResponse(
            '<a href="/docs/a?id=1">one</a><a href="/docs/a?id=2">two</a><a href="/docs/b?id=3">three</a>',
          )
        : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    let context: CheckEvaluationContext | undefined;
    const evaluator: CheckEvaluator = {
      evaluate: async (received) => {
        context = received;
        return [];
      },
    };

    await runScanWithEvaluator(
      input(scopeWithParameter(), { limits: createLimits({ maxActiveLinks: 5 }) }),
      deps,
      evaluator,
    );

    const urls = context?.candidates.map((candidate) => candidate.url) ?? [];
    expect(urls).toContain('https://example.com/docs/a?id=1');
    expect(urls).toContain('https://example.com/docs/a?id=2');
    expect(urls).not.toContain('https://example.com/docs/b?id=3');
    expect(urls).toHaveLength(2);
  });

  it('never lets a query value reach the result', async () => {
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse('<a href="/docs/a?id=secret-value">one</a>') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    const evaluator: CheckEvaluator = {
      evaluate: async () => [],
    };

    const result = await runScanWithEvaluator(input(scopeWithParameter()), deps, evaluator);

    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});

describe('a stop during the checks', () => {
  it('stops the scan instead of failing it', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const evaluator: CheckEvaluator = {
      evaluate: async () => {
        throw new ScanStopError('lease_lost', 'The scan lost its lease.');
      },
    };

    const result = await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('lease_lost');
    }
  });

  it('fails the scan when a check breaks the policy', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const evaluator: CheckEvaluator = {
      evaluate: async () => {
        throw new ScanPolicyError('host_not_allowed', 'The request host is not the host of this scan.');
      },
    };

    const result = await runScanWithEvaluator(input(createScope()), deps, evaluator);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('policy_violation');
    }
  });
});

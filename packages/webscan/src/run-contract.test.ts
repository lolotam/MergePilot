import { describe, expect, it } from 'vitest';

import { ScanPolicyError, ScanStopError, ScanTransportError } from './errors.js';
import { runScan } from './run.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput } from './types.js';

const BASE = 'https://example.com/';

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

describe('the terminal status of a scan', () => {
  it('stops the scan when the authorization is gone', async () => {
    const transport = createFakeTransport(() =>
      new ScanStopError('authorization_revoked', 'The scan is no longer authorized.'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('authorization_revoked');
    }
  });

  it('keeps a lost lease a stop and not a failure', async () => {
    const transport = createFakeTransport(() => {
      throw new ScanStopError('lease_lost', 'The scan lost its lease.');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') {
      expect(result.reason).toBe('lease_lost');
    }
  });

  it('fails the scan when the transport refuses the address', async () => {
    const transport = createFakeTransport(() => {
      throw new ScanPolicyError('address_not_allowed', 'The host could not be used for this request.');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('policy_violation');
    }
  });

  it('fails the scan when the site itself could not be read in time', async () => {
    const transport = createFakeTransport(() => {
      throw new ScanTransportError('timeout', 'The request did not complete in time.');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('transport_error');
    }
  });

  it('reports partial coverage when the crawler had to drop links', async () => {
    const links = Array.from(
      { length: 40 },
      (_unused, index) => `<a href="/docs/${index}">${index}</a>`,
    ).join('');
    const transport = createFakeTransport((call) =>
      call.url === BASE ? textResponse(links) : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);

    const result = await runScan(
      input({ limits: createLimits({ maxRequests: 3, maxResponseBytes: 16_384 }) }),
      deps,
    );

    expect(result.partialCoverage).toBe(true);
    expect(result.requests).toBeLessThanOrEqual(3);
  });

  it('never reports a failed scan as completed', async () => {
    const transport = createFakeTransport(() => {
      throw new ScanPolicyError('host_not_allowed', 'The request host is not the host of this scan.');
    });
    const { deps } = createDependencies(transport);

    const result = await runScan(input(), deps);

    expect(result.status).not.toBe('completed');
  });
});

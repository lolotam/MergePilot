import { describe, expect, it } from 'vitest';

import { ScanClient, type ScanClientRequest } from './client.js';
import { ScanPolicyError, ScanStopError, ScanTransportError } from './errors.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput } from './types.js';

const CRAWL: ScanClientRequest = { url: 'https://example.com/docs/a', kind: 'crawl' };

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

/** A transport that fails the way the app's transport fails. */
function failingTransport(error: unknown) {
  return createFakeTransport(() => error as Error);
}

describe('the typed contract of the transport', () => {
  it('keeps a refusal of the transport a refusal', async () => {
    const transport = failingTransport(
      new ScanPolicyError('address_not_allowed', 'The host could not be used for this request.'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanPolicyError);
    expect((error as ScanPolicyError).policyCode).toBe('address_not_allowed');
  });

  it('keeps a stop of the transport a stop', async () => {
    const transport = failingTransport(
      new ScanStopError('authorization_revoked', 'The scan is no longer authorized.'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('authorization_revoked');
  });

  it('classifies a refused connection as an ordinary transport failure', async () => {
    const transport = failingTransport(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('refused');
  });

  it('classifies a name that did not resolve as a transport failure, not a refusal', async () => {
    const transport = failingTransport(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect(error).not.toBeInstanceOf(ScanPolicyError);
    expect((error as ScanTransportError).transportCause).toBe('dns');
  });

  it('never lets the text of a transport error out', async () => {
    const transport = failingTransport(
      Object.assign(new Error('failed to fetch https://example.com/secret'), {
        code: 'ECONNRESET',
      }),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((reason: unknown) => reason);

    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('example.com');
  });

  it('sends a request that answers', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(response.status).toBe(200);
  });
});

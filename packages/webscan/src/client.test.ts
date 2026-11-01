import { describe, expect, it } from 'vitest';

import {
  MAX_REDIRECT_HOPS,
  ScanClient,
  type ScanClientRequest,
} from './client.js';
import {
  ScanPolicyError,
  ScanStopError,
  ScanTransportError,
} from './errors.js';
import {
  createDependencies,
  createFakeClock,
  createFakeTransport,
  createLimits,
  createScope,
  redirectResponse,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput } from './types.js';

const SCOPE = createScope();

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    scope: SCOPE,
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

const CRAWL: ScanClientRequest = { url: 'https://example.com/docs/a', kind: 'crawl' };

describe('the request budget', () => {
  it('counts every attempt before it is sent', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(transport.calls).toHaveLength(1);
    expect(client.requestCount).toBe(1);
  });

  it('counts a redirect hop as its own request', async () => {
    const transport = createFakeTransport((call) =>
      call.url.endsWith('/a') ? redirectResponse('https://example.com/docs/b') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(2);
    expect(client.requestCount).toBe(2);
    expect(response.hops).toBe(1);
    expect(response.destinationReached).toBe(true);
    expect(response.status).toBe(200);
  });

  it('stops the scan when the budget is exhausted', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input({ limits: createLimits({ maxRequests: 2 }) }), deps);

    await client.request(CRAWL);
    await client.request(CRAWL);
    await expect(client.request(CRAWL)).rejects.toThrow(ScanStopError);

    expect(transport.calls).toHaveLength(2);
  });

  it('counts a retry as its own request', async () => {
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 503 }) : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(2);
    expect(response.status).toBe(200);
  });
});

describe('the scope of a request', () => {
  it('refuses a first request that is outside the scope, without sending it', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(
      client.request({ url: 'https://other.example.com/docs/a', kind: 'crawl' }),
    ).rejects.toThrow(ScanPolicyError);
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses a lookalike host', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(
      client.request({ url: 'https://example.com.evil.io/docs/a', kind: 'crawl' }),
    ).rejects.toThrow(ScanPolicyError);
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses cleartext for an ordinary crawl target', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(
      client.request({ url: 'http://example.com/docs/a', kind: 'crawl' }),
    ).rejects.toThrow(ScanPolicyError);
    expect(transport.calls).toHaveLength(0);
  });

  it('binds an explicit target to its exact path', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(
      client.request({ url: 'https://example.com/other', kind: 'explicit', authorizedPath: '/' }),
    ).rejects.toThrow(ScanPolicyError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('redirects', () => {
  it('re-authorizes every hop and follows an authorized destination', async () => {
    const transport = createFakeTransport((call) =>
      call.url.endsWith('/a') ? redirectResponse('https://example.com/docs/b') : textResponse('ok'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls.map((call) => call.url)).toEqual([
      'https://example.com/docs/a',
      'https://example.com/docs/b',
    ]);
    expect(response.destinationReached).toBe(true);
  });

  it('stops the chain at a denied destination and keeps the 3xx as evidence', async () => {
    const transport = createFakeTransport(() => redirectResponse('https://example.com/admin'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(1);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/admin');
    expect(response.destinationReached).toBe(false);
  });

  it('stops the chain at a redirect to another listed host', async () => {
    const transport = createFakeTransport(() => redirectResponse('https://other.example.com/docs/a'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(1);
    expect(response.destinationReached).toBe(false);
  });

  it('stops the chain at a downgrade from https to http', async () => {
    const transport = createFakeTransport(() => redirectResponse('http://example.com/docs/a'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(1);
    expect(response.destinationReached).toBe(false);
  });

  it('never follows a location with another scheme', async () => {
    const transport = createFakeTransport(() => redirectResponse('javascript:alert(1)'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(1);
    expect(response.destinationReached).toBe(false);
  });

  it('follows at most five hops', async () => {
    const transport = createFakeTransport((call) => {
      const step = Number(/\/docs\/(\d+)$/.exec(call.url)?.[1] ?? '0');
      return redirectResponse(`https://example.com/docs/${step + 1}`);
    });
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(transport.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
    expect(response.hops).toBe(MAX_REDIRECT_HOPS);
    expect(response.destinationReached).toBe(false);
  });
});

describe('pacing and rate limiting', () => {
  it('spaces the requests at the configured rate', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input({ limits: createLimits({ requestsPerSecond: 2 }) }), deps);

    await client.request(CRAWL);
    await client.request(CRAWL);

    expect(clock.sleeps).toEqual([500]);
  });

  it('doubles the interval on the third consecutive rate limit', async () => {
    const transport = createFakeTransport((_call, index) =>
      index < 3 ? textResponse('', { status: 429 }) : textResponse('ok'),
    );
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input({ limits: createLimits({ requestsPerSecond: 2 }) }), deps);

    await client.request(CRAWL);

    expect(client.rateLimitStreak).toBe(0);
    expect(client.pacingIntervalMs).toBe(1000);
  });

  it('stops the scan on the sixth consecutive rate limit', async () => {
    const transport = createFakeTransport(() => textResponse('', { status: 503 }));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(client.request(CRAWL)).rejects.toThrow(ScanStopError);

    expect(transport.calls).toHaveLength(6);
  });

  it('resets the streak after a healthy response', async () => {
    const transport = createFakeTransport((_call, index) => {
      if (index === 0 || index === 2) {
        return textResponse('', { status: 429 });
      }
      return textResponse('ok');
    });
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(transport.calls.length).toBeGreaterThan(1);
    expect(client.rateLimitStreak).toBe(0);
  });
});

describe('Retry-After', () => {
  it('honours a delay in seconds', async () => {
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 429, headers: { 'retry-after': '2' } }) : textResponse('ok'),
    );
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(clock.sleeps).toContain(2000);
  });

  it('honours a delay given as a date', async () => {
    const start = Date.UTC(2026, 10, 1);
    const when = new Date(start + 30_000).toUTCString();
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 429, headers: { 'retry-after': when } }) : textResponse('ok'),
    );
    const clock = createFakeClock(start);
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(clock.sleeps).toEqual([30_000]);
  });

  it('caps the delay at a minute', async () => {
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 429, headers: { 'retry-after': '3600' } }) : textResponse('ok'),
    );
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(clock.sleeps).toContain(60_000);
  });

  it('never waits past the deadline of the scan', async () => {
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 429, headers: { 'retry-after': '60' } }) : textResponse('ok'),
    );
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(
      input({ limits: createLimits({ totalTimeoutMs: 1000 }) }),
      deps,
    );

    await expect(client.request(CRAWL)).rejects.toThrow(ScanStopError);

    expect(clock.sleeps).toEqual([1000]);
  });

  it('ignores a delay it cannot read', async () => {
    const transport = createFakeTransport((_call, index) =>
      index === 0 ? textResponse('', { status: 429, headers: { 'retry-after': 'soon' } }) : textResponse('ok'),
    );
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input({ limits: createLimits({ requestsPerSecond: 1 }) }), deps);

    await client.request(CRAWL);

    expect(clock.sleeps).toContain(1000);
  });
});

describe('the boundaries of the scan', () => {
  it('sends no request after the scan was cancelled', async () => {
    const controller = new AbortController();
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport, { signal: controller.signal });
    const client = new ScanClient(input(), deps);

    controller.abort();

    await expect(client.request(CRAWL)).rejects.toThrow(ScanStopError);
    expect(transport.calls).toHaveLength(0);
  });

  it('stops when the deadline of the scan passed', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const clock = createFakeClock();
    const { deps } = createDependencies(transport, { clock });
    const client = new ScanClient(input({ limits: createLimits({ totalTimeoutMs: 1000 }) }), deps);

    clock.advance(1000);

    await expect(client.request(CRAWL)).rejects.toThrow(ScanStopError);
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps one outbound request at a time', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await Promise.all([client.request(CRAWL), client.request(CRAWL)]);

    expect(transport.peakConcurrency).toBe(1);
  });
});

describe('the cleartext transport probe', () => {
  it('sends the one cleartext request the scanner may send', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request({ url: 'http://example.com/', kind: 'transport-probe' });

    expect(transport.calls.map((call) => call.url)).toEqual(['http://example.com/']);
    expect(response.status).toBe(200);
  });

  it('refuses a cleartext path', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await expect(
      client.request({ url: 'http://example.com/docs', kind: 'transport-probe' }),
    ).rejects.toThrow(ScanPolicyError);
    expect(transport.calls).toHaveLength(0);
  });

  it('inspects a redirect to an https destination without following it', async () => {
    const transport = createFakeTransport(() => redirectResponse('https://example.com/'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request({ url: 'http://example.com/', kind: 'transport-probe' });

    expect(transport.calls).toHaveLength(1);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/');
    expect(response.destinationReached).toBe(false);
  });

  it('keeps a failure of the probe a transport error and not a policy failure', async () => {
    const transport = createFakeTransport(() =>
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client
      .request({ url: 'http://example.com/', kind: 'transport-probe' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('reset');
  });
});

describe('what leaves the client', () => {
  it('sends nothing but the method and the signal', async () => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    await client.request(CRAWL);

    expect(transport.calls[0]?.initKeys).toEqual(['method', 'signal']);
  });

  it('keeps the raw text of a transport error out of the error it raises', async () => {
    const transport = createFakeTransport(() =>
      new Error('request to https://example.com/secret?token=abc failed'),
    );
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const error = await client.request(CRAWL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect(String((error as Error).message)).not.toContain('token=abc');
    expect(String((error as Error).message)).not.toContain('example.com');
  });

  it('bounds the body it reads', async () => {
    const transport = createFakeTransport(() => textResponse('x'.repeat(4096)));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input({ limits: createLimits({ maxResponseBytes: 1024 }) }), deps);

    const error = await client.request(CRAWL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('oversized');
  });

  it('reads the body of a normal response', async () => {
    const transport = createFakeTransport(() => textResponse('hello'));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(input(), deps);

    const response = await client.request(CRAWL);

    expect(new TextDecoder().decode(response.body)).toBe('hello');
  });
});

import { describe, expect, it } from 'vitest';

import { ScanClient } from './client.js';
import {
  createDependencies,
  createFakeTransport,
  createLimits,
  createScope,
  textResponse,
} from './test-support.fixtures.js';
import type { ScanInput } from './types.js';

const INPUT: ScanInput = {
  scope: createScope(),
  limits: createLimits(),
  checks: { headers: true, cookies: true, transport: true, disclosure: true, files: true, active: true },
  contact: 'ops@example.com',
};
const TARGET = { url: 'https://example.com/docs/a', kind: 'crawl' } as const;

describe('request guards after pacing', () => {
  it.each([250, 1000])('sends nothing at or past the deadline after a pacing wait of %i ms', async (totalTimeoutMs) => {
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps, clock } = createDependencies(transport);
    const client = new ScanClient({
      ...INPUT,
      limits: createLimits({ requestsPerSecond: 1, totalTimeoutMs }),
    }, deps);
    await client.request(TARGET);

    await expect(client.request(TARGET)).rejects.toMatchObject({ reason: 'time_limit' });

    expect(clock.sleeps).toEqual([totalTimeoutMs]);
    expect(transport.calls).toHaveLength(1);
  });

  it('sends nothing when cancellation arrives during a pacing wait', async () => {
    const controller = new AbortController();
    const transport = createFakeTransport(() => textResponse('ok'));
    const { deps, clock } = createDependencies(transport, { signal: controller.signal });
    deps.sleep = async (milliseconds, signal) => {
      await clock.sleep(milliseconds, signal);
      controller.abort();
    };
    const client = new ScanClient(INPUT, deps);
    await client.request(TARGET);

    await expect(client.request(TARGET)).rejects.toMatchObject({ reason: 'cancelled' });

    expect(transport.calls).toHaveLength(1);
  });
});

describe('rate-limit response cleanup', () => {
  it('cancels the sixth rate-limit body before stopping the scan', async () => {
    let cancellations = 0;
    const transport = createFakeTransport(() => new Response(new ReadableStream({
      cancel() { cancellations += 1; },
    }), { status: 503 }));
    const { deps } = createDependencies(transport);
    const client = new ScanClient(INPUT, deps);

    await expect(client.request(TARGET)).rejects.toMatchObject({ reason: 'rate_limited' });

    expect(transport.calls).toHaveLength(6);
    expect(cancellations).toBe(6);
  });
});


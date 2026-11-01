import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScanClient, type ScanClientRequest } from './client.js';
import { ScanStopError, ScanTransportError } from './errors.js';
import {
  createFakeClock,
  createLimits,
  createScope,
  targetKeyOf,
} from './test-support.fixtures.js';
import type { ScanDependencies, ScanInput } from './types.js';

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

/** One call the hanging transport received. */
interface HangingCall {
  readonly url: string;
  readonly signal: AbortSignal;
}

/**
 * Dependencies whose transport never answers and ignores the abort signal.
 *
 * A transport that ignores the signal is the case the client has to survive:
 * the attempt has to end even when the injected transport does not.
 */
function hangingDependencies(
  options: { signal?: AbortSignal; answer?: () => Response | Promise<Response> } = {},
) {
  const clock = createFakeClock();
  const calls: HangingCall[] = [];
  const deps: ScanDependencies = {
    fetch: (url, init) => {
      calls.push({ url, signal: init.signal });
      if (options.answer !== undefined) {
        return Promise.resolve(options.answer());
      }
      return new Promise<Response>(() => undefined);
    },
    now: clock.now,
    sleep: clock.sleep,
    signal: options.signal ?? new AbortController().signal,
    onProgress: () => undefined,
    identifyTarget: targetKeyOf,
    identifyOccurrence: () => 'occurrence',
  };
  return { deps, calls, clock };
}

/**
 * The error a promise rejected with.
 *
 * The handler is attached at once, so a rejection that happens while the test
 * advances its clock is never an unhandled rejection.
 */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the deadline of one request', () => {
  it('ends a request that never answers when the request timeout expires', async () => {
    vi.useFakeTimers();
    const { deps, calls } = hangingDependencies();
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }),
      deps,
    );

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('timeout');
  });

  it('ends a body that never ends when the request timeout expires', async () => {
    vi.useFakeTimers();
    const { deps, calls } = hangingDependencies({
      answer: () => new Response(new ReadableStream({ start: () => undefined })),
    });
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }),
      deps,
    );

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('timeout');
  });

  it.each([30, 10_000])('ends the scan when its deadline is no later than the request timeout (%i ms)', async (requestTimeoutMs) => {
    vi.useFakeTimers();
    const { deps } = hangingDependencies();
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs, totalTimeoutMs: 30 }) }),
      deps,
    );

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('time_limit');
  });

  it('keeps the request timeout when it is shorter than the whole deadline', async () => {
    vi.useFakeTimers();
    const { deps } = hangingDependencies();
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }),
      deps,
    );

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('timeout');
  });
});

describe('the cancellation of a request', () => {
  it('stops the scan when it is cancelled while a request is pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { deps } = hangingDependencies({ signal: controller.signal });
    const client = new ScanClient(input(), deps);

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('cancelled');
  });

  it('keeps the typed stop reason the abort carries', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { deps } = hangingDependencies({ signal: controller.signal });
    const client = new ScanClient(input(), deps);

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort(new ScanStopError('kill_switch', 'The kill switch is closed.'));
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('kill_switch');
  });

  it('releases the body of a response that arrives after the cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let released = false;
    let answer: ((response: Response) => void) | undefined;
    const { deps } = hangingDependencies({
      signal: controller.signal,
      answer: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const client = new ScanClient(input(), deps);

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await settled;

    // The transport answers after the attempt ended: the body is released, so
    // a late answer cannot hold the worker.
    answer?.(
      new Response(
        new ReadableStream({
          cancel: () => {
            released = true;
          },
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(released).toBe(true);
  });

  it('stops the scan when it is cancelled while the body is read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { deps } = hangingDependencies({
      signal: controller.signal,
      answer: () => new Response(new ReadableStream({ start: () => undefined })),
    });
    const client = new ScanClient(input(), deps);

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('cancelled');
  });

  it('forwards a derived signal, not the signal of the scan', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { deps, calls } = hangingDependencies({ signal: controller.signal });
    const client = new ScanClient(input(), deps);

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);

    const derived = calls[0]?.signal;
    expect(derived).toBeDefined();
    expect(derived).not.toBe(deps.signal);

    controller.abort();
    await settled;

    expect(derived?.aborted).toBe(true);
  });
});

describe('the cleanup of a client', () => {
  it.each([200, 503])('settles a %i response even when its stream cancellation never settles', async (status) => {
    vi.useFakeTimers();
    let cancellations = 0;
    const { deps } = hangingDependencies({
      answer: () => new Response(new ReadableStream({
        cancel: () => {
          cancellations += 1;
          return new Promise<void>(() => undefined);
        },
      }), { status }),
    });
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }), deps,
    );
    let finished = false;
    let failure: unknown;
    const pending = client.request(CRAWL).then(
      () => { finished = true; },
      (error: unknown) => { finished = true; failure = error; },
    );

    await vi.advanceTimersByTimeAsync(30);

    expect(finished).toBe(true);
    expect(cancellations).toBeGreaterThan(0);
    expect(failure).toMatchObject(status === 200 ? { transportCause: 'timeout' } : { reason: 'rate_limited' });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind after a request', async () => {
    vi.useFakeTimers();
    const { deps } = hangingDependencies({
      answer: () => new Response('ok'),
    });
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }),
      deps,
    );

    await client.request(CRAWL);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind after a request that failed', async () => {
    vi.useFakeTimers();
    const { deps } = hangingDependencies();
    const client = new ScanClient(
      input({ limits: createLimits({ requestTimeoutMs: 30, totalTimeoutMs: 10_000 }) }),
      deps,
    );

    const pending = client.request(CRAWL);
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);
    await settled;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no request after the scan stopped', async () => {
    const { deps, calls } = hangingDependencies({ answer: () => new Response('ok') });
    const client = new ScanClient(input({ limits: createLimits({ maxRequests: 1 }) }), deps);

    await client.request(CRAWL);
    const error = await rejection(client.request(CRAWL));

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('request_limit');
    expect(calls).toHaveLength(1);
  });
});

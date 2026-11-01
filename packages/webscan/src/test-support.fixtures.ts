/**
 * Test doubles for the scanner package.
 *
 * The doubles are deliberately small and deterministic: a clock the test
 * drives, a transport the test scripts, and a scope the test narrows. No
 * test in this package ever reaches the network.
 */

import { createHash } from 'node:crypto';

import { createSiteIdentity } from './identity.js';
import type { ScanDependencies, ScanLimits, ScanScope } from './types.js';

/** A clock the test drives. */
export interface FakeClock {
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Every wait the scan asked for, in order. */
  readonly sleeps: number[];
  /** Moves the clock forward without a wait. */
  advance: (milliseconds: number) => void;
}

/** A clock that only moves when the scan waits. */
export function createFakeClock(start = 0): FakeClock {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw new Error('aborted');
      }
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    sleeps,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/** One call the fake transport received. */
export interface RecordedCall {
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  readonly signal: AbortSignal;
  /** The keys of the init object, so a test can prove nothing else was sent. */
  readonly initKeys: readonly string[];
}

/** A transport the test scripts. */
export interface FakeTransport {
  readonly fetch: ScanDependencies['fetch'];
  readonly calls: RecordedCall[];
  /** How many calls were in flight at the same time. */
  readonly peakConcurrency: number;
}

/**
 * A transport that answers from a handler.
 *
 * The handler receives the recorded call and answers with a response, or with
 * an error that the transport throws.
 */
export function createFakeTransport(
  handler: (call: RecordedCall, index: number) => Response | Error,
): FakeTransport {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let peakConcurrency = 0;
  const fetch: ScanDependencies['fetch'] = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method,
      signal: init.signal,
      initKeys: Object.keys(init),
    };
    calls.push(call);
    inFlight += 1;
    peakConcurrency = Math.max(peakConcurrency, inFlight);
    try {
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    } finally {
      inFlight -= 1;
    }
  };
  return {
    fetch,
    calls,
    get peakConcurrency(): number {
      return peakConcurrency;
    },
  };
}

/** A response with a body and headers. */
export function textResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

/** A response that redirects to another URL. */
export function redirectResponse(location: string, status = 302): Response {
  return new Response('', { status, headers: { location } });
}

/** The scope the tests narrow. */
export function createScope(overrides: Partial<ScanScope> = {}): ScanScope {
  return {
    hostname: 'example.com',
    baseUrl: 'https://example.com/',
    crawlPaths: [{ path: '/docs', kind: 'prefix' }],
    blockedPaths: [{ path: '/checkout', kind: 'prefix' }],
    parameterizedPaths: [],
    activePaths: [],
    extraFilePaths: [],
    ...overrides,
  };
}

/** The limits the tests narrow. */
export function createLimits(overrides: Partial<ScanLimits> = {}): ScanLimits {
  return {
    maxRequests: 50,
    maxPages: 10,
    maxActiveLinks: 5,
    requestsPerSecond: 2,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1024,
    totalTimeoutMs: 600_000,
    ...overrides,
  };
}

/** The identity the doubles give a baseline URL: a digest, never the URL. */
export function targetKeyOf(baselineUrl: string): string {
  return `target-${createHash('sha256').update(baselineUrl).digest('hex').slice(0, 16)}`;
}

/**
 * The identity functions of one site.
 *
 * The doubles that need the identity of the app, such as a test of the
 * canonical target identity, use these and not the digest of a raw URL.
 */
export const SITE_IDENTITY = createSiteIdentity(new Uint8Array(32).fill(7));

/** The dependencies of one scan, wired to the doubles. */
export interface FakeDependencies {
  readonly deps: ScanDependencies;
  readonly clock: FakeClock;
  readonly transport: FakeTransport;
  readonly progress: Array<{ requests: number; pages: number; phase: string }>;
}

/** Builds the dependencies of one scan around the given transport. */
export function createDependencies(
  transport: FakeTransport,
  options: { clock?: FakeClock; signal?: AbortSignal } = {},
): FakeDependencies {
  const clock = options.clock ?? createFakeClock();
  const progress: Array<{ requests: number; pages: number; phase: string }> = [];
  const deps: ScanDependencies = {
    fetch: transport.fetch,
    now: clock.now,
    sleep: clock.sleep,
    signal: options.signal ?? new AbortController().signal,
    onProgress: (event) => {
      progress.push({ requests: event.requests, pages: event.pages, phase: event.phase });
    },
    identifyTarget: targetKeyOf,
    identifyOccurrence: (input) => `occurrence-${input.targetKey}-${input.checkId}-${input.issueId}`,
  };
  return { deps, clock, transport, progress };
}

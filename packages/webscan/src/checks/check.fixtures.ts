/**
 * Test doubles for the catalogue checks.
 *
 * The doubles build the evaluation context a check needs: the pages the scan
 * received, the identity functions of the app and a request capability that
 * records what a check asked for. No check test ever reaches the network.
 */

import type { ScanCandidate } from '../candidates.js';
import type { ScanCheckRequester } from '../check-requests.js';
import type { ScanClientResponse } from '../client.js';
import type { CheckEvaluation, CheckEvaluationContext, CheckTarget } from '../evaluation.js';
import type { SiteIdentity } from '../identity.js';
import { createLimits, createScope, targetKeyOf } from '../test-support.fixtures.js';
import type { CheckSwitches, ScanLimits, ScanScope } from '../types.js';

/** One request a check asked the scan for. */
export interface RecordedRequest {
  readonly kind: 'probe' | 'file' | 'baseline' | 'active' | 'bind';
  /** The path, the URL or the script path the request carried. */
  readonly value: string;
}

/** A request capability that records what a check asked for. */
export interface FakeRequester {
  readonly requester: ScanCheckRequester;
  readonly calls: RecordedRequest[];
}

/**
 * An answer that is not a real response.
 *
 * It describes the answers a real server produces and a `Response` cannot
 * express: a scope-denied redirect answers with the 3xx and never reaches the
 * destination, so the body belongs to no page of the link.
 */
export interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Whether the body of the requested destination was reached. */
  readonly destinationReached?: boolean;
}

/** The answer of one recorded request. */
export type RequestAnswer = Response | Error | FakeResponse;

/** Turns a response into the answer a check receives. */
async function toClientResponse(response: Response): Promise<ScanClientResponse> {
  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    headers: response.headers,
    body: new Uint8Array(buffer),
    destinationReached: true,
    hops: 0,
    finalUrl: response.url,
  };
}

/** Turns a described answer into the answer a check receives. */
function toFakeClientResponse(answer: FakeResponse): ScanClientResponse {
  return {
    status: answer.status,
    headers: new Headers(answer.headers ?? {}),
    body: new TextEncoder().encode(answer.body ?? ''),
    destinationReached: answer.destinationReached ?? true,
    hops: 0,
    finalUrl: '',
  };
}

/** Builds a request capability that answers from a script. */
export function createFakeRequester(
  answer: (call: RecordedRequest) => RequestAnswer = () => new Response(''),
): FakeRequester {
  const calls: RecordedRequest[] = [];
  const respond = async (call: RecordedRequest): Promise<ScanClientResponse> => {
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) {
      throw result;
    }
    if (result instanceof Response) {
      return await toClientResponse(result);
    }
    return toFakeClientResponse(result);
  };
  return {
    calls,
    requester: {
      probeRootPort80: () => respond({ kind: 'probe', value: 'http://example.com/' }),
      getFixedFile: (path: string) => respond({ kind: 'file', value: path }),
      bindDiscoveredScripts: (scriptPaths: readonly string[]) => {
        calls.push({ kind: 'bind', value: scriptPaths.join(',') });
        return scriptPaths.map((path) => `${path}.map`);
      },
      getBaseline: (candidate: ScanCandidate) =>
        respond({ kind: 'baseline', value: candidate.url }),
      probeActive: (candidate: ScanCandidate, probeUrl: string) =>
        respond({ kind: 'active', value: probeUrl }),
    },
  };
}

/** One page a check may look at. */
export interface TargetOptions {
  readonly url: string;
  readonly status?: number;
  readonly headers?: Record<string, string | readonly string[]>;
  readonly body?: string;
  readonly finalUrl?: string;
  readonly location?: string | null;
  readonly destinationReached?: boolean;
}

/** Builds one page of a check context. */
export function createTarget(options: TargetOptions): CheckTarget {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }
    headers.set(name, value);
  }
  const body = options.body ?? '';
  return {
    targetKey: targetKeyOf(options.url),
    baselineUrl: options.url,
    finalUrl: options.finalUrl ?? options.url,
    location: options.location ?? null,
    kind: 'crawl',
    status: options.status ?? 200,
    headers,
    body: new TextEncoder().encode(body),
    destinationReached: options.destinationReached ?? true,
  };
}

/** The options of a check context. */
export interface CheckContextOptions {
  readonly scope?: Partial<ScanScope>;
  readonly limits?: Partial<ScanLimits>;
  readonly targets?: readonly CheckTarget[];
  readonly candidates?: readonly ScanCandidate[];
  readonly requester?: ScanCheckRequester;
  readonly checks?: Partial<CheckSwitches>;
  /** The sink the check publishes its evaluations to. */
  readonly emit?: (batch: readonly CheckEvaluation[]) => void;
  /** The identity functions of the app. */
  readonly identity?: SiteIdentity;
}

/** Builds the context one check runs in. */
export function createCheckContext(options: CheckContextOptions = {}): CheckEvaluationContext {
  const requester = options.requester ?? createFakeRequester().requester;
  return {
    scope: createScope(options.scope),
    limits: createLimits(options.limits),
    targets: options.targets ?? [],
    unreadableTargetKeys: [],
    request: requester,
    identity: options.identity ?? {
      identifyTarget: targetKeyOf,
      identifyOccurrence: (input) =>
        `occurrence-${input.targetKey}-${input.checkId}-${input.issueId}-${input.subject}`,
    },
    candidates: options.candidates ?? [],
    checks: {
      headers: true,
      cookies: true,
      transport: true,
      disclosure: true,
      files: true,
      active: true,
      ...options.checks,
    },
    emit: options.emit ?? (() => {}),
  };
}

/** One authorized parameterized link. */
export function createCandidate(
  url: string,
  parameterNames: readonly string[],
  targetKey: string = targetKeyOf(url),
): ScanCandidate {
  const parsed = new URL(url);
  return {
    url,
    path: parsed.pathname,
    targetKey,
    parameterNames,
  };
}

/** The link the active check tests use. */
export const ACTIVE_LINK = 'https://example.com/search?q=books';

/** The scope that opts the active check in for that link. */
export const ACTIVE_SCOPE = {
  parameterizedPaths: [{ path: '/search', parameters: ['q'] }],
  activePaths: [{ path: '/search', parameters: ['q'] }],
};

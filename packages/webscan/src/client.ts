/**
 * The guarded request client (ADR-0052 section 2).
 *
 * The client is the package's second guard. The injected transport applies the
 * address checks and the pinning; the client re-applies the policy a
 * transport cannot know about — the host of *this* scan, the scheme, the port,
 * the request budget, the pacing, the redirect budget, and the scope the
 * original target was authorized under.
 *
 * Four rules shape the implementation:
 *
 * - Every attempt, retry and redirect hop is counted **before** it is sent, so
 *   an injected transport cannot spend more of the budget than the
 *   administrator approved.
 * - Every hop is re-authorized against the scope of the request that started
 *   the chain. A redirect never inherits authorization from its source.
 * - Every attempt is bounded. The shorter of the request timeout and the time
 *   left of the scan ends the attempt, whether it is waiting for the response
 *   or reading its body, even when the transport ignores the abort signal.
 * - Nothing that a hostile target could influence — a raw URL, a transport
 *   error message — leaves this module in a message, a log or a result.
 */

import { abortReason, createAttempt, raceWithSignal } from './cancellation.js';
import {
  ScanPolicyError,
  ScanStopError,
  ScanTransportError,
  isScanControlError,
  stopMessage,
  stopReasonOfSignal,
  transportCauseOf,
  type ScanTransportCause,
} from './errors.js';
import {
  evaluateActiveProbeTarget,
  evaluateCrawlTarget,
  evaluateExplicitTarget,
  evaluateParameterizedTarget,
  evaluateTransportProbe,
  matchesPathRule,
  parseCanonicalUrl,
  type ScopeDecision,
} from './scope.js';
import { MAX_REDIRECT_HOPS, redirectLocation, resolveHop } from './redirects.js';
import type { ScanDependencies, ScanInput, ScanStopReason } from './types.js';

export { MAX_REDIRECT_HOPS } from './redirects.js';

/** Which authorization rules a request and its redirect hops are bound to. */
export type ScanTargetKind =
  | 'crawl'
  | 'explicit'
  | 'transport-probe'
  | 'parameterized'
  | 'active-probe';

/**
 * One request the scan wants to make.
 *
 * The kinds are the kinds of authorization ADR-0052 section 2 describes, and
 * they are not interchangeable:
 *
 * - `crawl` follows the administrator's crawl path rules.
 * - `explicit` is bound to one exact path: the base page or the fixed path of
 *   an enabled check. It carries that path so a redirect cannot wander off it.
 * - `transport-probe` is the single cleartext request the scanner may send.
 * - `parameterized` is the baseline of a separately authorized parameterized
 *   link. It carries the exact path of that link.
 * - `active-probe` is the same, under the additional active opt-in.
 */
export type ScanClientRequest =
  | { readonly url: string; readonly kind: 'crawl'; readonly method?: 'GET' | 'HEAD' }
  | {
      readonly url: string;
      readonly kind: 'explicit';
      readonly authorizedPath: string;
      readonly method?: 'GET' | 'HEAD';
    }
  | { readonly url: string; readonly kind: 'transport-probe'; readonly method?: 'GET' | 'HEAD' }
  | {
      readonly url: string;
      readonly kind: 'parameterized';
      readonly authorizedPath: string;
      readonly method?: 'GET' | 'HEAD';
    }
  | {
      readonly url: string;
      readonly kind: 'active-probe';
      readonly authorizedPath: string;
      readonly method?: 'GET' | 'HEAD';
    };

/** The response of one chain, with its body already read and bounded. */
export interface ScanClientResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The bounded body of the response that was received. */
  readonly body: Uint8Array;
  /**
   * Whether the body of the requested destination was reached.
   *
   * It is false when a scope-denied redirect or the redirect budget ended the
   * chain: the 3xx was received and stays available as evidence, but the
   * destination itself was never requested.
   */
  readonly destinationReached: boolean;
  /** How many redirect hops were followed. */
  readonly hops: number;
  /** The URL the chain ended at. Transient: it never leaves this process. */
  readonly finalUrl: string;
}

/** Consecutive rate-limit replies that double the pacing interval. */
const RATE_LIMIT_BACKOFF_AFTER = 3;

/** Consecutive rate-limit replies that stop the scan. */
const RATE_LIMIT_STOP_AFTER = 6;

/** The longest honoured Retry-After. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Classifies a transport failure from its error code.
 *
 * Only the short code is read. The message of an untrusted error may carry
 * the raw URL, so it is never kept.
 */
function classifyTransportCause(error: unknown): ScanTransportCause {
  return transportCauseOf(error);
}

/** The redirect statuses the client follows manually. */

/**
 * Whether a URL is a canonical HTTP URL.
 *
 * A URL that is not canonical is never requested: it may carry a scheme the
 * scanner does not speak or an address it may not reach.
 */
function isCanonicalUrl(candidate: string): boolean {
  try {
    parseCanonicalUrl(candidate);
    return true;
  } catch {
    return false;
  }
}

/** The client of one scan. */
export class ScanClient {
  private readonly input: ScanInput;
  private readonly deps: ScanDependencies;
  private readonly deadline: number;
  private requests = 0;
  private consecutiveRateLimits = 0;
  private intervalMs: number;
  private nextSendAt: number;
  private tail: Promise<unknown> = Promise.resolve();
  /** The reason the scan stopped, once a stop happened. */
  private stopped: ScanStopReason | undefined;

  constructor(input: ScanInput, deps: ScanDependencies) {
    this.input = input;
    this.deps = deps;
    this.deadline = deps.now() + input.limits.totalTimeoutMs;
    this.intervalMs = 1000 / input.limits.requestsPerSecond;
    this.nextSendAt = deps.now();
  }

  /** How many requests were sent, including retries and redirect hops. */
  get requestCount(): number {
    return this.requests;
  }

  /** How many requests the budget of the scan still allows. */
  get remainingRequests(): number {
    return Math.max(0, this.input.limits.maxRequests - this.requests);
  }

  /** The current pacing interval in milliseconds. */
  get pacingIntervalMs(): number {
    return this.intervalMs;
  }

  /** How many rate-limit replies arrived in a row. */
  get rateLimitStreak(): number {
    return this.consecutiveRateLimits;
  }

  /** The reason the scan stopped, when it stopped. */
  get stopReason(): ScanStopReason | undefined {
    return this.stopped;
  }

  /**
   * Runs one request and follows its redirect chain.
   *
   * Chains never overlap: the client keeps one outbound request at a time, as
   * ADR-0052 section 2 requires.
   */
  async request(target: ScanClientRequest): Promise<ScanClientResponse> {
    return this.serialize(() => this.runChain(target));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runChain(target: ScanClientRequest): Promise<ScanClientResponse> {
    const method = target.method ?? 'GET';
    let current = this.authorizeInitial(target);
    let hops = 0;
    for (;;) {
      const response = await this.send(current, method);
      const location = redirectLocation(response);
      if (location === null) {
        return { ...response, destinationReached: true, hops, finalUrl: current };
      }
      if (hops >= MAX_REDIRECT_HOPS) {
        return { ...response, destinationReached: false, hops, finalUrl: current };
      }
      const next = resolveHop(current, location, isCanonicalUrl);
      if (next === null) {
        return { ...response, destinationReached: false, hops, finalUrl: current };
      }
      if (!this.evaluate(target, next).allowed) {
        // The destination is outside the scope. Only this chain ends: the
        // denied destination is never requested, and the 3xx stays available
        // as evidence for the checks that do not need the destination body.
        return { ...response, destinationReached: false, hops, finalUrl: current };
      }
      current = next;
      hops += 1;
    }
  }

  /** Rejects a first request that is outside the authorized scope. */
  private authorizeInitial(target: ScanClientRequest): string {
    const decision = this.evaluate(target, target.url);
    if (!decision.allowed) {
      throw new ScanPolicyError(
        decision.reason ?? 'path_not_allowed',
        'The request is outside the authorized scope.',
      );
    }
    return target.url;
  }

  /**
   * The scope decision for one URL under the rules of the given request.
   *
   * A crawl target follows the crawl path rules; an explicit target is bound
   * to its exact authorized path; the transport probe may only reach the
   * fixed root of the same host over cleartext; a parameterized link and an
   * active probe need their own separate authorization.
   */
  private evaluate(target: ScanClientRequest, rawUrl: string): ScopeDecision {
    const scope = this.input.scope;
    if (target.kind === 'crawl') {
      return evaluateCrawlTarget(scope, rawUrl);
    }
    if (target.kind === 'transport-probe') {
      return evaluateTransportProbe(scope, rawUrl);
    }
    const decision =
      target.kind === 'parameterized'
        ? evaluateParameterizedTarget(scope, rawUrl)
        : target.kind === 'active-probe'
          ? evaluateActiveProbeTarget(scope, rawUrl)
          : evaluateExplicitTarget(scope, rawUrl);
    if (!decision.allowed || target.authorizedPath === undefined) {
      return decision;
    }
    const parsed = parseCanonicalUrl(rawUrl);
    const bound = matchesPathRule({ path: target.authorizedPath, kind: 'exact' }, parsed.segments);
    return bound ? decision : { allowed: false, reason: 'path_not_allowed' };
  }

  /**
   * Sends one request, retrying a rate-limit reply.
   *
   * A 429 or 503 is retried after the honoured Retry-After, the pacing
   * interval doubles on the third consecutive reply and the scan stops on the
   * sixth. Any other reply resets the streak.
   */
  private async send(
    url: string,
    method: 'GET' | 'HEAD',
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    for (;;) {
      this.assertCanSend();
      await this.pace();
      this.assertCanSend();
      this.requests += 1;
      const outcome = await this.attemptRequest(url, method);
      if ('retryAfterMs' in outcome) {
        await this.wait(outcome.retryAfterMs);
        continue;
      }
      return outcome;
    }
  }

  /**
   * Runs one bounded attempt: the request and the reading of its body.
   *
   * The attempt owns its own signal and its own timer. The timer is disposed
   * on every path, so a direct caller of the client never leaves a pending
   * timer behind.
   */
  private async attemptRequest(
    url: string,
    method: 'GET' | 'HEAD',
  ): Promise<{ status: number; headers: Headers; body: Uint8Array } | { retryAfterMs: number }> {
    const budget = this.attemptBudget();
    const attempt = createAttempt({
      outer: this.deps.signal,
      timeoutMs: budget.milliseconds,
      timeoutError: budget.expiryError,
    });
    try {
      const response = await this.dispatch(url, method, attempt.signal);
      if (response.status === 429 || response.status === 503) {
        this.consecutiveRateLimits += 1;
        await this.discardBody(response);
        if (this.consecutiveRateLimits >= RATE_LIMIT_STOP_AFTER) {
          throw new ScanStopError('rate_limited', stopMessage('rate_limited'));
        }
        if (this.consecutiveRateLimits === RATE_LIMIT_BACKOFF_AFTER) {
          this.intervalMs *= 2;
        }
        return { retryAfterMs: this.retryAfterMs(response.headers) };
      }
      this.consecutiveRateLimits = 0;
      return {
        status: response.status,
        headers: response.headers,
        body: await this.readBody(response, attempt.signal),
      };
    } catch (error) {
      throw this.classify(error, attempt.signal);
    } finally {
      attempt.dispose();
    }
  }

  /**
   * The budget of one attempt.
   *
   * The shorter of the request timeout and the time left of the scan wins.
   * When the scan runs out of time first, the attempt ends the scan; when the
   * request runs out of time first, it ends the request.
   */
  private attemptBudget(): { milliseconds: number; expiryError: () => Error } {
    const remaining = this.deadline - this.deps.now();
    if (remaining <= 0) {
      throw new ScanStopError('time_limit', stopMessage('time_limit'));
    }
    const requestMs = this.input.limits.requestTimeoutMs;
    if (remaining <= requestMs) {
      return {
        milliseconds: remaining,
        expiryError: () => new ScanStopError('time_limit', stopMessage('time_limit')),
      };
    }
    return {
      milliseconds: requestMs,
      expiryError: () => new ScanTransportError('timeout', 'The request did not complete in time.'),
    };
  }

  /** Performs one call of the injected transport. */
  private async dispatch(url: string, method: 'GET' | 'HEAD', signal: AbortSignal): Promise<Response> {
    const pending = this.deps.fetch(url, { method, signal });
    // A response that arrives after the attempt ended must not keep its body:
    // the socket is released, so a late answer cannot hold the worker.
    pending.then(
      (response) => {
        if (signal.aborted) {
          void this.discardBody(response);
        }
      },
      () => undefined,
    );
    return await raceWithSignal(pending, signal);
  }

  /**
   * Turns whatever the transport threw into the typed control contract.
   *
   * A typed error of the contract is kept as it is, so a refusal of the
   * transport stays a refusal. An abort ends the attempt with the reason it
   * carries. Everything else is an ordinary transport failure.
   */
  private classify(error: unknown, signal: AbortSignal): Error {
    if (isScanControlError(error)) {
      this.rememberStop(error);
      return error;
    }
    if (signal.aborted) {
      const reason = abortReason(signal);
      if (isScanControlError(reason)) {
        this.rememberStop(reason);
        return reason;
      }
      return new ScanStopError('cancelled', stopMessage('cancelled'));
    }
    // The original error is dropped on purpose: its text can carry the raw
    // URL, and no transport text may reach a result, a progress event or a
    // log.
    return new ScanTransportError(
      classifyTransportCause(error),
      'The request could not be completed.',
    );
  }

  /** Remembers a stop, so no later request is sent after it. */
  private rememberStop(error: unknown): void {
    if (error instanceof ScanStopError) {
      this.stopped = error.reason;
    }
  }

  /** Refuses to send when the scan may not send. */
  private assertCanSend(): void {
    if (this.stopped !== undefined) {
      throw new ScanStopError(this.stopped, stopMessage(this.stopped));
    }
    if (this.deps.signal.aborted) {
      const reason = stopReasonOfSignal(this.deps.signal);
      this.stopped = reason;
      throw new ScanStopError(reason, stopMessage(reason));
    }
    if (this.deps.now() >= this.deadline) {
      this.stopped = 'time_limit';
      throw new ScanStopError('time_limit', stopMessage('time_limit'));
    }
    if (this.requests >= this.input.limits.maxRequests) {
      this.stopped = 'request_limit';
      throw new ScanStopError('request_limit', stopMessage('request_limit'));
    }
  }

  /** Spaces the requests out at the configured rate. */
  private async pace(): Promise<void> {
    const waitMs = this.nextSendAt - this.deps.now();
    if (waitMs > 0) {
      await this.wait(waitMs);
    }
    this.nextSendAt = this.deps.now() + this.intervalMs;
  }

  /** The longest wait a Retry-After may ask for. */
  private retryAfterMs(headers: Headers): number {
    const raw = headers.get('retry-after');
    if (raw === null) {
      return this.intervalMs;
    }
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
    }
    const timestamp = Date.parse(trimmed);
    if (Number.isNaN(timestamp)) {
      return this.intervalMs;
    }
    return Math.min(Math.max(timestamp - this.deps.now(), 0), MAX_RETRY_AFTER_MS);
  }

  /** Waits, but never past the scan deadline and never after a cancellation. */
  private async wait(milliseconds: number): Promise<void> {
    const remaining = this.deadline - this.deps.now();
    if (remaining <= 0) {
      throw new ScanStopError('time_limit', stopMessage('time_limit'));
    }
    await this.sleep(Math.min(milliseconds, remaining));
  }

  /** A cancellable sleep that reports a cancellation as a stop. */
  private async sleep(milliseconds: number): Promise<void> {
    if (this.deps.signal.aborted) {
      const reason = stopReasonOfSignal(this.deps.signal);
      this.stopped = reason;
      throw new ScanStopError(reason, stopMessage(reason));
    }
    try {
      await this.deps.sleep(milliseconds, this.deps.signal);
    } catch (error) {
      if (this.deps.signal.aborted) {
        const reason = stopReasonOfSignal(this.deps.signal);
        this.stopped = reason;
        throw new ScanStopError(reason, stopMessage(reason));
      }
      throw error;
    }
  }

  /**
   * Reads the body of a response, bounded while it is consumed.
   *
   * The cap is applied by this package as well as by the transport, so an
   * injected transport that ignores it cannot exhaust the memory of the
   * worker. The reading ends with the attempt: an abort cancels the reader and
   * releases the socket.
   */
  private async readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    const limit = this.input.limits.maxResponseBytes;
    const stream = response.body;
    if (stream === null) {
      return new Uint8Array(0);
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await raceWithSignal(reader.read(), signal);
        if (done) {
          break;
        }
        if (value === undefined) {
          continue;
        }
        total += value.byteLength;
        if (total > limit) {
          throw new ScanTransportError('oversized', 'The response body exceeded the size limit.');
        }
        chunks.push(value);
      }
    } catch (error) {
      // A hostile stream may never settle cancellation. Start cleanup without
      // allowing it to delay the already determined timeout or stop outcome.
      void reader.cancel().catch(() => undefined);
      if (isScanControlError(error)) {
        throw error;
      }
      if (signal.aborted) {
        throw abortReason(signal);
      }
      throw new ScanTransportError('unknown', 'The response body could not be read.');
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /** Drops a body the client will not read, so the socket is released. */
  private async discardBody(response: Response): Promise<void> {
    if (response.body === null) {
      return;
    }
    try {
      void response.body.cancel().catch(() => undefined);
    } catch {
      // Cleanup is best-effort. A transport may reject or throw while dropping
      // its body; that must not delay a terminal scan outcome or a retry.
    }
  }
}

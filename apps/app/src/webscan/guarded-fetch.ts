import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import {
  ScanPolicyError,
  ScanStopError,
  ScanTransportError,
  buildScannerUserAgent,
  canonicalHostname,
  isScanControlError,
  raceWithSignal,
  transportCauseOf,
} from '@mergepilot/webscan';

import { byteCapStream, pinnedLookup, toHeaders } from '../core/http-plumbing.js';
import {
  defaultLookup,
  resolveSafeAddresses,
  SsrFResolutionError,
  SsrFValidationError,
  type DnsLookupFn,
} from '../core/ssrf.js';

/**
 * The guarded transport of the website scanner (ADR-0052 section 2).
 *
 * The transport is the outer guard. On every request it re-checks the host of
 * the scan, resolves the name and accepts only public addresses, connects to
 * exactly the address it checked (the lookup is pinned, so a DNS answer that
 * changes after the check is never used) and verifies the TLS certificate.
 *
 * Four things it never does:
 *
 * - It never follows a redirect. Every hop is a separate call that passes the
 *   same guards again, so the scope of the destination is checked by the
 *   package before the hop is made.
 * - It never sends a cookie, an authorization header or any credential. The
 *   only header it writes is the scanner User-Agent.
 * - It never sends a cleartext request other than the fixed root probe of
 *   ADR-0052 section 2: the port 80 root of the same host, without a query
 *   and without a fragment. It never copies the base path into cleartext,
 *   because a base path may hold a secret.
 * - It never fails open. Every refusal and every failure is reported through
 *   the typed contract of the package: a refusal is a policy error, a lost
 *   authorization is a stop, and a network that did not answer is a transport
 *   error.
 *
 * The timer of a request and the controller that carries the abort exist
 * before the first await of the call: the live authorization and the name
 * resolution are part of the request, so a scan that is cancelled or that runs
 * out of time while they are pending never sends anything.
 */

/** What the live authorization check learns about a request. */
export interface ScanRequestInfo {
  /** The canonical hostname of the scan. */
  readonly hostname: string;
  /** The request URL. Transient: it never reaches a result or a log. */
  readonly url: URL;
  readonly method: 'GET' | 'HEAD';
  /**
   * The signal of the request.
   *
   * The check may pass it to whatever it waits for, so a cancellation reaches
   * the worker instead of the timeout of the request.
   */
  readonly signal: AbortSignal;
}

/** The request function, as a test seam. */
export type ScanRequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

/** The guarded fetch, shaped like the scan dependency of the package. */
export type GuardedScanFetch = (
  url: string,
  init: { method: 'GET' | 'HEAD'; signal: AbortSignal },
) => Promise<Response>;

export interface GuardedScanFetchOptions {
  /** The exact hostname of the site this scan may talk to. */
  readonly hostname: string;
  /** The contact advertised in the User-Agent. */
  readonly contact: string;
  /** Test seam: the name resolver (defaults to the system resolver). */
  readonly lookup?: DnsLookupFn | undefined;
  /** Test seam: the http/https request function. */
  readonly request?: ScanRequestFn | undefined;
  /** Whole call, headers and body included (default 30 s). */
  readonly timeoutMs?: number | undefined;
  /** Longest silence on the socket, connecting included (default 15 s). */
  readonly idleTimeoutMs?: number | undefined;
  /** Largest response body accepted (default 5 MB). */
  readonly maxResponseBytes?: number | undefined;
  /** Aborts every call made with this fetch. */
  readonly signal?: AbortSignal | undefined;
  /**
   * The live authorization check.
   *
   * It runs before every request, so a revoked authorization, a closed kill
   * switch or a lost lease stops the scan at its next hop. The worker injects
   * it; the transport itself does not know what the authorization is.
   *
   * A rejection fails closed: the scan stops instead of continuing without an
   * authorization it could not confirm.
   */
  readonly authorize?: ((info: ScanRequestInfo) => boolean | Promise<boolean>) | undefined;
}

/** The default limits of one scanner request. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Statuses that carry no body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function defaultRequest(
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
): ClientRequest {
  return url.protocol === 'https:'
    ? httpsRequest(url, options, callback)
    : httpRequest(url, options, callback);
}

/**
 * Parses a request URL under the transport rules.
 *
 * Only the host of the scan may be addressed. Over cleartext only the fixed
 * root path may be requested, and never with a query or a fragment.
 */
function parseScanUrl(raw: string, hostname: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ScanPolicyError('invalid_url', 'The request URL could not be parsed.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ScanPolicyError('unsupported_scheme', 'Only http and https requests are supported.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ScanPolicyError('credentials_present', 'A request URL must not carry credentials.');
  }
  if (canonicalHostname(parsed.hostname) !== hostname) {
    throw new ScanPolicyError('host_not_allowed', 'The request host is not the host of this scan.');
  }
  if (parsed.protocol === 'http:') {
    if (parsed.port !== '' && parsed.port !== '80') {
      throw new ScanPolicyError('non_default_port', 'Only the default port is allowed.');
    }
    if (parsed.pathname !== '/') {
      throw new ScanPolicyError('path_not_allowed', 'Only the fixed root path may be requested.');
    }
    if (parsed.search !== '') {
      throw new ScanPolicyError('query_not_allowed', 'A cleartext request must not carry a query.');
    }
    if (parsed.hash !== '') {
      throw new ScanPolicyError('query_not_allowed', 'A cleartext request must not carry a fragment.');
    }
    return parsed;
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new ScanPolicyError('non_default_port', 'Only the default port is allowed.');
  }
  return parsed;
}

/**
 * Turns whatever the transport threw into the typed contract of the package.
 *
 * The text of an error is never kept: it names the host, and a transport
 * message must not reach a result, a progress event or a log.
 */
function toControlError(error: unknown, signal: AbortSignal): Error {
  if (isScanControlError(error)) {
    return error;
  }
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (isScanControlError(reason)) {
      return reason;
    }
    return new ScanStopError('cancelled', 'The request was aborted.');
  }
  if (error instanceof SsrFResolutionError) {
    // The name did not resolve. That is an outage of the resolver, not a
    // decision about the address.
    return new ScanTransportError('dns', 'The host name could not be resolved.');
  }
  if (error instanceof SsrFValidationError) {
    // The name resolved to an address the scan may not reach.
    return new ScanPolicyError('address_not_allowed', 'The host could not be used for this request.');
  }
  return new ScanTransportError(transportCauseOf(error), 'The request could not be completed.');
}

/**
 * Creates the guarded transport of one scan.
 *
 * The contact is validated when the transport is created, so an unusable
 * contact fails before the scan sends anything rather than in the middle of
 * it.
 */
export function createGuardedScanFetch(options: GuardedScanFetchOptions): GuardedScanFetch {
  const lookupFn = options.lookup ?? defaultLookup;
  const doRequest = options.request ?? defaultRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const hostname = canonicalHostname(options.hostname);
  const userAgent = buildScannerUserAgent(options.contact);

  return async (input, init) => {
    const url = parseScanUrl(input, hostname);
    // A plain controller with a real timer, so the deadline cannot be
    // collected before it fires. They exist before the first await: the
    // authorization and the name resolution are part of the request.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ScanTransportError('timeout', 'The request did not complete in time.'));
    }, timeoutMs);
    const abortHandlers: Array<() => void> = [];
    const done = () => {
      clearTimeout(timer);
      for (const remove of abortHandlers) remove();
    };
    for (const outer of [init.signal, options.signal]) {
      if (!outer) continue;
      if (outer.aborted) {
        controller.abort(outer.reason);
        continue;
      }
      const handler = () => controller.abort(outer.reason);
      outer.addEventListener('abort', handler, { once: true });
      abortHandlers.push(() => outer.removeEventListener('abort', handler));
    }
    const signal = controller.signal;

    try {
      if (options.authorize !== undefined) {
        let allowed: boolean;
        try {
          allowed = await raceWithSignal(
            Promise.resolve(options.authorize({ hostname, url, method: init.method, signal })),
            signal,
          );
        } catch (error) {
          // An abort is the scan's own decision and keeps its reason. A typed
          // error of the contract keeps its reason too. Every other rejection
          // fails closed: the scan may not continue without an authorization it
          // could not confirm.
          if (signal.aborted || isScanControlError(error)) {
            throw error;
          }
          throw new ScanStopError(
            'authorization_revoked',
            'The scan could not confirm its authorization.',
          );
        }
        if (!allowed) {
          throw new ScanStopError('authorization_revoked', 'The scan is no longer authorized.');
        }
      }

      const addresses = await raceWithSignal(resolveSafeAddresses(url.hostname, lookupFn), signal);
      signal.throwIfAborted();

      return await new Promise<Response>((resolve, reject) => {
        const req = doRequest(
          url,
          {
            method: init.method,
            // The only headers the scanner writes. No cookie, no authorization,
            // no credential of any kind is ever added or inherited.
            headers: {
              'user-agent': userAgent,
              accept: '*/*',
              'accept-encoding': 'identity',
            },
            lookup: pinnedLookup(addresses),
            agent: false,
            // The TLS certificate is verified against the host of the scan.
            rejectUnauthorized: true,
            signal,
          },
          (res) => {
            const raw = res.statusCode ?? 502;
            const status = raw >= 100 && raw <= 599 ? raw : 502;
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) {
              done();
              res.destroy();
              reject(
                new ScanTransportError('oversized', 'The response body is larger than the limit.'),
              );
              return;
            }
            const empty = NULL_BODY_STATUSES.has(status) || init.method === 'HEAD';
            if (empty) {
              done();
              res.resume();
              resolve(new Response(null, { status, statusText: res.statusMessage ?? '', headers: toHeaders(res.headers) }));
              return;
            }
            const capped = res.pipe(
              byteCapStream(
                maxBytes,
                () => new ScanTransportError('oversized', 'The response body is larger than the limit.'),
              ),
            );
            res.on('error', (err) => capped.destroy(err));
            capped.once('error', () => res.destroy());
            // The deadline and the abort listener stay in force until the body
            // has been consumed: they are not dropped when the headers arrive.
            capped.once('close', () => {
              res.destroy();
              done();
            });
            resolve(
              new Response(Readable.toWeb(capped) as unknown as ReadableStream<Uint8Array>, {
                status,
                statusText: res.statusMessage ?? '',
                headers: toHeaders(res.headers),
              }),
            );
          },
        );
        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new ScanTransportError('timeout', 'The server stopped sending data.'));
        });
        req.on('error', (err) => {
          done();
          reject(err);
        });
        req.end();
      });
    } catch (error) {
      done();
      throw toControlError(error, signal);
    }
  };
}

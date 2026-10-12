import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Readable, Transform } from 'node:stream';
import type { FetchLike } from '@mergepilot/engine';
import { defaultLookup, parseSafeUrl, resolveSafeAddresses, type DnsLookupFn, type ResolvedAddress } from './ssrf.js';

type PinnedLookup = NonNullable<RequestOptions['lookup']>;

/** Limits for dashboard calls (model list, connection test): small answers, quick replies. */
export const DASHBOARD_FETCH_LIMITS = { timeoutMs: 30_000, idleTimeoutMs: 15_000, maxResponseBytes: 5 * 1024 * 1024 };
/** Limits for a worker review call: a streamed answer with thinking can be long and slow. */
export const REVIEW_FETCH_LIMITS = { timeoutMs: 10 * 60_000, idleTimeoutMs: 3 * 60_000, maxResponseBytes: 32 * 1024 * 1024 };

export class SafeFetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchLimitError';
  }
}

/** A lookup that only ever answers with the addresses already checked by the SSRF guard. */
function pinnedLookup(addresses: readonly ResolvedAddress[]): PinnedLookup {
  return ((
    _hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    const first = addresses[0];
    if (!first) {
      callback(new Error('no checked address'), '', 0);
      return;
    }
    if (options.all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, first.address, first.family);
  }) as PinnedLookup;
}

function requestBody(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  throw new TypeError('the guarded fetch only sends string bodies');
}

function responseHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return headers;
}

/** Passes bytes through and fails the stream once more than `max` bytes went by. */
function sizeCap(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > max) done(new SafeFetchLimitError(`response body exceeds ${max} bytes`));
      else done(null, chunk);
    },
  });
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface SafeFetchOptions {
  lookup?: DnsLookupFn | undefined;
  /** Test seam: the https request function (defaults to node:https `request`). */
  request?: typeof httpsRequest | undefined;
  /** Whole call, headers and body included (default 30 s). */
  timeoutMs?: number | undefined;
  /** Longest silence on the socket, connecting included (default 15 s). */
  idleTimeoutMs?: number | undefined;
  /** Largest response body accepted (default 5 MB). */
  maxResponseBytes?: number | undefined;
  /** Aborts every call made with this fetch (e.g. the dashboard request went away). */
  signal?: AbortSignal | undefined;
}

/**
 * A fetch for the user-chosen `custom` base URL (ADR-0010). On EVERY call it re-runs the SSRF
 * guard (https, public addresses only), then connects to exactly the addresses it checked (the
 * lookup is pinned, so a DNS answer that changes after the check is never used), and it never
 * follows a redirect: a 3xx comes back as a failed response. TLS still verifies the host name.
 * Every call has an overall and an idle timeout and a response size cap, so a hostile server can
 * neither hold the connection nor stream an endless body.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): FetchLike {
  const lookupFn = options.lookup ?? defaultLookup;
  const doRequest = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? DASHBOARD_FETCH_LIMITS.timeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DASHBOARD_FETCH_LIMITS.idleTimeoutMs;
  const maxBytes = options.maxResponseBytes ?? DASHBOARD_FETCH_LIMITS.maxResponseBytes;

  return async (input, init = {}) => {
    const url = parseSafeUrl(input);
    // A plain controller with a real timer (not AbortSignal.any / .timeout, whose signals are
    // only weakly held and can be collected before they fire); cleared when the call ends.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new SafeFetchLimitError(`no complete answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const done = () => clearTimeout(timer);
    for (const outer of [init.signal, options.signal]) {
      if (!outer) continue;
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    const signal = controller.signal;
    if (signal.aborted) {
      done();
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    let addresses: ResolvedAddress[];
    let body: string | undefined;
    try {
      addresses = await resolveSafeAddresses(url.hostname, lookupFn);
      body = requestBody(init.body);
      signal.throwIfAborted();
    } catch (err) {
      done();
      throw err;
    }
    const headers = new Headers(init.headers);
    headers.set('accept-encoding', 'identity');
    if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
    const method = (init.method ?? 'GET').toUpperCase();

    return new Promise<Response>((resolve, reject) => {
      const req = doRequest(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          lookup: pinnedLookup(addresses),
          agent: false,
          signal,
        },
        (res) => {
          const raw = res.statusCode ?? 502;
          const status = raw >= 200 && raw <= 599 ? raw : 502;
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            done();
            res.destroy();
            reject(new SafeFetchLimitError(`response body exceeds ${maxBytes} bytes`));
            return;
          }
          const empty = NULL_BODY_STATUSES.has(status) || method === 'HEAD';
          let stream: ReadableStream<Uint8Array> | null = null;
          if (empty) {
            done();
            res.resume();
          } else {
            const capped = res.pipe(sizeCap(maxBytes));
            res.on('error', (err) => capped.destroy(err));
            capped.once('close', done);
            stream = Readable.toWeb(capped) as unknown as ReadableStream<Uint8Array>;
          }
          resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders(res.headers) }));
        },
      );
      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(new SafeFetchLimitError(`no data from the server for ${idleTimeoutMs} ms`));
      });
      req.on('error', (err) => {
        done();
        reject(err);
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}

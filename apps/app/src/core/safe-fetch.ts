import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Readable } from 'node:stream';
import type { FetchLike } from '@mergepilot/engine';
import { defaultLookup, parseSafeUrl, resolveSafeAddresses, type DnsLookupFn, type ResolvedAddress } from './ssrf.js';

type PinnedLookup = NonNullable<RequestOptions['lookup']>;

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

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface SafeFetchOptions {
  lookup?: DnsLookupFn | undefined;
  /** Test seam: the https request function (defaults to node:https `request`). */
  request?: typeof httpsRequest | undefined;
}

/**
 * A fetch for the user-chosen `custom` base URL (ADR-0010). On EVERY call it re-runs the SSRF
 * guard (https, public addresses only), then connects to exactly the addresses it checked (the
 * lookup is pinned, so a DNS answer that changes after the check is never used), and it never
 * follows a redirect: a 3xx comes back as a failed response. TLS still verifies the host name.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): FetchLike {
  const lookupFn = options.lookup ?? defaultLookup;
  const doRequest = options.request ?? httpsRequest;
  return async (input, init = {}) => {
    const url = parseSafeUrl(input);
    const addresses = await resolveSafeAddresses(url.hostname, lookupFn);
    const body = requestBody(init.body);
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
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const raw = res.statusCode ?? 502;
          const status = raw >= 200 && raw <= 599 ? raw : 502;
          const empty = NULL_BODY_STATUSES.has(status) || method === 'HEAD';
          if (empty) res.resume();
          const stream = empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders(res.headers) }));
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}

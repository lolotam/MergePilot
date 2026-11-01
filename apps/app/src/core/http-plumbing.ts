import type { LookupAddress, LookupOptions } from 'node:dns';
import { Transform } from 'node:stream';
import type { RequestOptions } from 'node:https';

import type { ResolvedAddress } from './ssrf.js';

export type PinnedLookup = NonNullable<RequestOptions['lookup']>;

/**
 * A lookup that only ever answers with the addresses already checked by the SSRF guard.
 *
 * The connection therefore reaches exactly the address that was validated, so
 * a DNS answer that changes between the check and the connect cannot swap a
 * public address for a private one.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): PinnedLookup {
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

/**
 * Passes bytes through and fails the stream once more than `max` bytes went by.
 *
 * The cap is applied while the body is consumed, so a hostile server cannot
 * stream an endless answer into the worker.
 */
export function byteCapStream(max: number, makeError: () => Error): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > max) done(makeError());
      else done(null, chunk);
    },
  });
}

/** Converts Node's raw response headers into a `Headers` object. */
export function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return headers;
}

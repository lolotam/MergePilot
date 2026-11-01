import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import type { DnsLookupFn } from '../core/ssrf.js';
import { createGuardedScanFetch, type ScanRequestFn } from './guarded-fetch.js';

/** One call the fake request function received. */
export interface Captured {
  url: URL;
  options: RequestOptions;
  idle?: () => void;
  response?: IncomingMessage;
}

/**
 * A fake request function: records the call and answers with `status` /
 * `headers` / `body` (`body: null` never answers). It honours the abort
 * signal and the idle timeout like Node does.
 */
export function fakeRequest(
  status: number,
  headers: Record<string, string>,
  body: string | Buffer[] | Readable | null,
  captured: Captured[],
): ScanRequestFn {
  return ((url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    const entry: Captured = { url, options };
    captured.push(entry);
    const req = new EventEmitter() as unknown as ClientRequest;
    const destroy = (err?: Error) => {
      queueMicrotask(() => req.emit('error', err ?? new Error('destroyed')));
      return req;
    };
    options.signal?.addEventListener('abort', () =>
      destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    Object.assign(req, {
      write: () => req,
      setTimeout: (_ms: number, cb: () => void) => {
        entry.idle = cb;
        return req;
      },
      destroy,
      end: () => {
        if (body === null) return;
        const chunks = typeof body === 'string' ? [Buffer.from(body)] : body;
        const res = (chunks instanceof Readable ? chunks : Readable.from(chunks)) as IncomingMessage;
        entry.response = res;
        Object.assign(res, { statusCode: status, statusMessage: '', headers });
        onResponse(res);
      },
    });
    return req;
  }) as unknown as ScanRequestFn;
}

/** A resolver that answers with a public address. */
export const publicLookup: DnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

/** The host the tests scan. */
export const HOST = 'example.com';

/** The overrides the tests narrow the guarded fetch with. */
export interface FetchOverrides {
  lookup?: DnsLookupFn;
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer[] | Readable | null;
  contact?: string;
  hostname?: string;
  authorize?: (info: { hostname: string; method: string; signal: AbortSignal }) => boolean | Promise<boolean>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Builds a guarded fetch around the fake request function. */
export function createFetch(captured: Captured[], overrides: FetchOverrides = {}) {
  return createGuardedScanFetch({
    hostname: overrides.hostname ?? HOST,
    contact: overrides.contact ?? 'ops@example.com',
    lookup: overrides.lookup ?? publicLookup,
    request: fakeRequest(
      overrides.status ?? 200,
      overrides.headers ?? {},
      overrides.body === undefined ? '{}' : overrides.body,
      captured,
    ),
    ...(overrides.authorize === undefined ? {} : { authorize: overrides.authorize }),
    ...(overrides.maxResponseBytes === undefined ? {} : { maxResponseBytes: overrides.maxResponseBytes }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: overrides.idleTimeoutMs }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
}

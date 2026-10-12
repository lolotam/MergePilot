import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createSafeFetch } from './safe-fetch.js';
import type { DnsLookupFn } from './ssrf.js';

type RequestFn = typeof httpsRequest;
type LookupCallback = (err: Error | null, address: unknown, family?: number) => void;
type PinnedLookupFn = (host: string, opts: { all?: boolean }, cb: LookupCallback) => void;

interface Captured {
  url: URL;
  options: { method?: string; headers?: Record<string, string>; lookup?: PinnedLookupFn; agent?: unknown };
  written: string[];
}

/** A fake https.request: records the call and answers with `status` / `headers` / `body`. */
function fakeRequest(status: number, headers: Record<string, string>, body: string, captured: Captured[]): RequestFn {
  return ((url: URL, options: Captured['options'], onResponse: (res: IncomingMessage) => void) => {
    const entry: Captured = { url, options, written: [] };
    captured.push(entry);
    const req = new EventEmitter() as unknown as ClientRequest;
    Object.assign(req, {
      write: (chunk: string) => entry.written.push(chunk),
      end: () => {
        const res = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
        Object.assign(res, { statusCode: status, statusMessage: '', headers });
        onResponse(res);
      },
    });
    return req;
  }) as unknown as RequestFn;
}

const publicLookup: DnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

describe('createSafeFetch (custom base URL, ADR-0010)', () => {
  it('pins the connection to the checked addresses and sends the body', async () => {
    const captured: Captured[] = [];
    const safeFetch = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, '{"data":[]}', captured) });
    const res = await safeFetch('https://llm.example.com/v1/models', { method: 'POST', body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(captured[0]?.written).toEqual(['{"a":1}']);
    expect(captured[0]?.options.agent).toBe(false);

    // Whatever the resolver says at connect time, the socket gets only the checked address.
    const lookup = captured[0]?.options.lookup;
    const one = await new Promise<unknown[]>((resolve) => lookup?.('llm.example.com', {}, (...args) => resolve(args)));
    expect(one).toEqual([null, '93.184.216.34', 4]);
    const all = await new Promise<unknown[]>((resolve) => lookup?.('llm.example.com', { all: true }, (...args) => resolve(args)));
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });

  it('re-resolves on every call, so a host rebound to a private address is refused before connecting', async () => {
    const captured: Captured[] = [];
    const answers = ['93.184.216.34', '127.0.0.1'];
    const rebinding: DnsLookupFn = async () => [{ address: answers.shift() ?? '127.0.0.1', family: 4 }];
    const safeFetch = createSafeFetch({ lookup: rebinding, request: fakeRequest(200, {}, '{}', captured) });
    await safeFetch('https://llm.example.com/v1/models');
    await expect(safeFetch('https://llm.example.com/v1/models')).rejects.toThrow('private or loopback');
    expect(captured).toHaveLength(1);
  });

  it('never follows a redirect: the 3xx comes back as a failed response', async () => {
    const captured: Captured[] = [];
    const redirect = fakeRequest(302, { location: 'https://169.254.169.254/latest' }, '', captured);
    const safeFetch = createSafeFetch({ lookup: publicLookup, request: redirect });
    const res = await safeFetch('https://llm.example.com/v1/models');
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
    expect(captured).toHaveLength(1);
  });

  it('refuses http, private IP literals and metadata names without any request', async () => {
    const request = vi.fn() as unknown as RequestFn;
    const safeFetch = createSafeFetch({ lookup: publicLookup, request });
    await expect(safeFetch('http://llm.example.com/v1')).rejects.toThrow('HTTPS only');
    await expect(safeFetch('https://169.254.169.254/v1')).rejects.toThrow('private or loopback');
    await expect(safeFetch('https://[::ffff:7f00:1]/v1')).rejects.toThrow('private or loopback');
    await expect(safeFetch('https://metadata.google.internal/v1')).rejects.toThrow('private');
    expect(request).not.toHaveBeenCalled();
  });
});

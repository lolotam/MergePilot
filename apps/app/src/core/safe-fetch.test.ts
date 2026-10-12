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
  options: {
    method?: string;
    headers?: Record<string, string>;
    lookup?: PinnedLookupFn;
    agent?: unknown;
    signal?: AbortSignal;
  };
  written: string[];
  idle?: () => void;
}

/**
 * A fake https.request: records the call and answers with `status` / `headers` / `body`
 * (`body: null` never answers). It honours the abort signal and the idle timeout like Node.
 */
function fakeRequest(
  status: number,
  headers: Record<string, string>,
  body: string | Buffer[] | null,
  captured: Captured[],
): RequestFn {
  return ((url: URL, options: Captured['options'], onResponse: (res: IncomingMessage) => void) => {
    const entry: Captured = { url, options, written: [] };
    captured.push(entry);
    const req = new EventEmitter() as unknown as ClientRequest;
    const destroy = (err?: Error) => {
      queueMicrotask(() => req.emit('error', err ?? new Error('destroyed')));
      return req;
    };
    options.signal?.addEventListener('abort', () => destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    Object.assign(req, {
      write: (chunk: string) => entry.written.push(chunk),
      setTimeout: (_ms: number, cb: () => void) => {
        entry.idle = cb;
        return req;
      },
      destroy,
      end: () => {
        if (body === null) return;
        const chunks = typeof body === 'string' ? [Buffer.from(body)] : body;
        const res = Readable.from(chunks) as unknown as IncomingMessage;
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

  it('fails a call that hangs, after the overall timeout', async () => {
    const safeFetch = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, null, []), timeoutMs: 20 });
    await expect(safeFetch('https://llm.example.com/v1/models')).rejects.toThrow();
  });

  it('fails a silent connection on the idle timeout', async () => {
    const captured: Captured[] = [];
    const safeFetch = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, null, captured), idleTimeoutMs: 5 });
    const pending = safeFetch('https://llm.example.com/v1/models');
    await vi.waitFor(() => expect(captured[0]?.idle).toBeDefined());
    captured[0]?.idle?.();
    await expect(pending).rejects.toThrow('no data from the server');
  });

  it('honours the caller signal combined with its own limits', async () => {
    const controller = new AbortController();
    const safeFetch = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, null, []), signal: controller.signal });
    const pending = safeFetch('https://llm.example.com/v1/models');
    controller.abort();
    await expect(pending).rejects.toThrow();
    const perCall = new AbortController();
    perCall.abort();
    const plain = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, '{}', []) });
    await expect(plain('https://llm.example.com/v1/models', { signal: perCall.signal })).rejects.toThrow();
  });

  it('refuses a body larger than the cap, declared or streamed', async () => {
    const declared = createSafeFetch({
      lookup: publicLookup,
      request: fakeRequest(200, { 'content-length': '999999' }, '{}', []),
      maxResponseBytes: 1000,
    });
    await expect(declared('https://llm.example.com/v1/models')).rejects.toThrow('exceeds 1000 bytes');

    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(400, 97));
    const streamed = createSafeFetch({ lookup: publicLookup, request: fakeRequest(200, {}, chunks, []), maxResponseBytes: 1000 });
    const res = await streamed('https://llm.example.com/v1/models');
    await expect(res.text()).rejects.toThrow();
  });

  it('connects to exactly the host it checked, for every URL spelling', async () => {
    const seen: string[] = [];
    const lookup: DnsLookupFn = async (host) => (seen.push(host), [{ address: '93.184.216.34', family: 4 }]);
    const captured: Captured[] = [];
    const safeFetch = createSafeFetch({ lookup, request: fakeRequest(200, {}, '{}', captured) });
    await safeFetch('HTTPS://LLM.Example.COM.:8443\\v1/models');
    await safeFetch('https://bücher.example/v1/models');
    expect(seen).toEqual(['llm.example.com.', 'xn--bcher-kva.example']);
    expect(captured.map((c) => c.url.hostname)).toEqual(seen);
    expect(captured[0]?.url.port).toBe('8443');
    expect(captured[0]?.url.pathname).toBe('/v1/models');
  });
});

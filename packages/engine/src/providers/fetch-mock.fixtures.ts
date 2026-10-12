import { vi } from 'vitest';
import type { FetchLike } from './http.js';

export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function textResponse(text: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

/** An SSE body built from `data:` payloads (objects are JSON-encoded). */
export function sseResponse(events: ReadonlyArray<unknown>): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A fetch mock answering each call with the next responder; every call is recorded. */
export function mockFetch(...responders: Array<Response | ((url: string, init: RequestInit) => Response | Promise<Response>)>) {
  const calls: RecordedCall[] = [];
  let next = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, init, headers, body });
    const responder = responders[Math.min(next++, responders.length - 1)];
    if (!responder) throw new Error('no responder');
    return typeof responder === 'function' ? responder(url, init) : responder.clone();
  });
  return { fetch: fn as unknown as FetchLike, calls };
}

/** A fetch that never answers until its signal aborts, like a hung provider. */
export function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
}

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ScanPolicyError, ScanStopError } from '@mergepilot/webscan';

import type { DnsLookupFn } from '../core/ssrf.js';
import { createFetch, type Captured } from './guarded-fetch.fixtures.js';

describe('the address of the host', () => {
  it('refuses a host that resolves to a private address', async () => {
    const captured: Captured[] = [];
    const privateLookup: DnsLookupFn = async () => [{ address: '127.0.0.1', family: 4 }];
    const scanFetch = createFetch(captured, { lookup: privateLookup });

    await expect(scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal })).rejects.toThrow(
      ScanPolicyError,
    );
    expect(captured).toHaveLength(0);
  });

  it('refuses a host that resolves to a link-local metadata address', async () => {
    const captured: Captured[] = [];
    const metadataLookup: DnsLookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
    const scanFetch = createFetch(captured, { lookup: metadataLookup });

    await expect(scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal })).rejects.toThrow(
      'could not be used',
    );
    expect(captured).toHaveLength(0);
  });

  it('connects to exactly the address it checked, whatever the resolver says later', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal });

    const lookup = captured[0]?.options.lookup;
    const one = await new Promise<unknown[]>((resolve) => lookup?.('example.com', {}, (...args) => resolve(args)));
    expect(one).toEqual([null, '93.184.216.34', 4]);
  });

  it('re-checks the address on every request', async () => {
    const captured: Captured[] = [];
    const answers = ['93.184.216.34', '127.0.0.1'];
    const rebinding: DnsLookupFn = async () => [{ address: answers.shift() ?? '127.0.0.1', family: 4 }];
    const scanFetch = createFetch(captured, { lookup: rebinding });
    const signal = new AbortController().signal;

    await scanFetch('https://example.com/', { method: 'GET', signal });
    await expect(scanFetch('https://example.com/', { method: 'GET', signal })).rejects.toThrow('could not be used');
    expect(captured).toHaveLength(1);
  });
});

describe('the host of the scan', () => {
  it('refuses another host, even one that is listed', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('https://other.example.com/', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('not the host of this scan');
    expect(captured).toHaveLength(0);
  });

  it('refuses a lookalike host', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('https://example.com.evil.io/', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('not the host of this scan');
  });

  it('refuses another port on the same host', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('https://example.com:8443/', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('default port');
    expect(captured).toHaveLength(0);
  });

  it('refuses a URL with credentials', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('https://user:secret@example.com/', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('must not carry credentials');
  });
});

describe('cleartext', () => {
  it('allows the fixed root of the same host', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    const response = await scanFetch('http://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(response.status).toBe(200);
    expect(captured[0]?.url.protocol).toBe('http:');
    expect(captured[0]?.url.pathname).toBe('/');
  });

  it('refuses a cleartext path', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('http://example.com/docs', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('fixed root path');
    expect(captured).toHaveLength(0);
  });

  it('refuses a cleartext query and a cleartext fragment', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await expect(
      scanFetch('http://example.com/?a=1', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('query');
    await expect(
      scanFetch('http://example.com/#part', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('fragment');
    expect(captured).toHaveLength(0);
  });
});

describe('what the request carries', () => {
  it('sends the scanner User-Agent and nothing else', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal });

    const headers = captured[0]?.options.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('MergePilot-WebScan/1 (+ops@example.com)');
    expect(Object.keys(headers).sort()).toEqual(['accept', 'accept-encoding', 'user-agent']);
    expect(headers['cookie']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('refuses to start with a contact it cannot use as a header', () => {
    const captured: Captured[] = [];
    expect(() => createFetch(captured, { contact: 'ops@example.com\r\nX-Injected: 1' })).toThrow();
  });

  it('verifies the TLS certificate', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured);

    await scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal });

    expect(captured[0]?.options.rejectUnauthorized).toBe(true);
  });

  it('never follows a redirect', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      status: 302,
      headers: { location: 'https://example.com/docs' },
    });

    const response = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/docs');
    expect(captured).toHaveLength(1);
  });
});

describe('the limits of one request', () => {
  it('refuses a body larger than the cap while it is consumed', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { body: 'x'.repeat(4096), maxResponseBytes: 1000 });

    const response = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    await expect(response.text()).rejects.toThrow();
  });

  it('fails a server that stops sending data', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { body: null, idleTimeoutMs: 5 });
    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(captured[0]?.idle).toBeDefined());
    captured[0]?.idle?.();

    await expect(pending).rejects.toThrow();
  });

  it('honours the abort signal of the caller', async () => {
    const captured: Captured[] = [];
    const controller = new AbortController();
    const scanFetch = createFetch(captured, { body: null });
    const pending = scanFetch('https://example.com/', { method: 'GET', signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it('keeps the deadline in force while the body is read', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { body: null, timeoutMs: 20 });
    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    await expect(pending).rejects.toThrow();
  });
});

describe('stream source cleanup', () => {
  it('destroys a still-open source when the streamed body exceeds its cap', async () => {
    let sent = false;
    const body = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.alloc(16));
        }
      },
    });
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { body, maxResponseBytes: 8 });
    const response = await scanFetch('https://example.com/', {
      method: 'GET', signal: new AbortController().signal,
    });

    try {
      await expect(response.arrayBuffer()).rejects.toThrow();
      expect(captured[0]?.response?.destroyed).toBe(true);
    } finally {
      body.destroy();
    }
  });
});

describe('the live authorization', () => {
  it('checks the authorization before every request', async () => {
    const captured: Captured[] = [];
    const seen: string[] = [];
    const scanFetch = createFetch(captured, {
      authorize: (info) => {
        seen.push(info.hostname);
        return true;
      },
    });
    const signal = new AbortController().signal;

    await scanFetch('https://example.com/', { method: 'GET', signal });
    await scanFetch('https://example.com/', { method: 'GET', signal });

    expect(seen).toEqual(['example.com', 'example.com']);
  });

  it('sends nothing when the authorization is gone', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { authorize: () => false });

    await expect(
      scanFetch('https://example.com/', { method: 'GET', signal: new AbortController().signal }),
    ).rejects.toThrow('no longer authorized');
    expect(captured).toHaveLength(0);
  });

  it('reports a lost authorization as a stop of the scan', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, { authorize: () => false });

    const error = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('authorization_revoked');
    expect(captured).toHaveLength(0);
  });

  it('fails closed when the authorization check rejects', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      authorize: () => Promise.reject(new Error('the lease table is gone')),
    });

    const error = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('authorization_revoked');
    expect((error as Error).message).not.toContain('lease table');
    expect(captured).toHaveLength(0);
  });

  it('keeps the typed stop reason the check reports', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      authorize: () => Promise.reject(new ScanStopError('lease_lost', 'The lease is gone.')),
    });

    const error = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanStopError);
    expect((error as ScanStopError).reason).toBe('lease_lost');
    expect(captured).toHaveLength(0);
  });
});


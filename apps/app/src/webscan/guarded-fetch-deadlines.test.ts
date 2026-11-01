import { describe, expect, it, vi } from 'vitest';

import { ScanPolicyError, ScanStopError, ScanTransportError } from '@mergepilot/webscan';

import { createFetch, type Captured } from './guarded-fetch.fixtures.js';

/**
 * The parts of a request that may answer late.
 *
 * The live authorization and the name resolution are part of a request: they
 * happen before the connection is opened, and a scan that is cancelled or
 * that runs out of time while they are pending must send nothing at all.
 */
describe('the parts of a request that answer late', () => {
  it('ends a request whose authorization never arrives', async () => {
    vi.useFakeTimers();
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      timeoutMs: 30,
      authorize: () => new Promise<boolean>(() => undefined),
    });

    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('timeout');
    expect(captured).toHaveLength(0);
    vi.useRealTimers();
  });

  it('ends a request whose name never resolves', async () => {
    vi.useFakeTimers();
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      timeoutMs: 30,
      lookup: () => new Promise<never>(() => undefined),
    });

    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanTransportError);
    expect((error as ScanTransportError).transportCause).toBe('timeout');
    expect(captured).toHaveLength(0);
    vi.useRealTimers();
  });

  it('sends nothing when the authorization arrives after the cancellation', async () => {
    const captured: Captured[] = [];
    const controller = new AbortController();
    let allow: ((allowed: boolean) => void) | undefined;
    const scanFetch = createFetch(captured, {
      authorize: () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
        }),
    });

    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    controller.abort();
    allow?.(true);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect(captured).toHaveLength(0);
  });

  it('sends nothing when the name resolves after the cancellation', async () => {
    const captured: Captured[] = [];
    const controller = new AbortController();
    let resolved: ((addresses: Array<{ address: string; family: number }>) => void) | undefined;
    const scanFetch = createFetch(captured, {
      lookup: () =>
        new Promise((resolve) => {
          resolved = resolve;
        }),
    });

    const pending = scanFetch('https://example.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    controller.abort();
    resolved?.([{ address: '93.184.216.34', family: 4 }]);
    const error = await settled;

    expect(error).toBeInstanceOf(ScanStopError);
    expect(captured).toHaveLength(0);
  });

  it('reports a name that did not resolve as a transport failure', async () => {
    const captured: Captured[] = [];
    const scanFetch = createFetch(captured, {
      lookup: () => Promise.reject(new Error('ENOTFOUND')),
    });

    const error = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanTransportError);
    expect(error).not.toBeInstanceOf(ScanPolicyError);
    expect((error as ScanTransportError).transportCause).toBe('dns');
    expect(captured).toHaveLength(0);
  });

  it('keeps a private address a refusal of the policy', async () => {
    const captured: Captured[] = [];
    const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
    const scanFetch = createFetch(captured, { lookup: privateLookup });

    const error = await scanFetch('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ScanPolicyError);
    expect((error as ScanPolicyError).policyCode).toBe('address_not_allowed');
    expect(captured).toHaveLength(0);
  });
});

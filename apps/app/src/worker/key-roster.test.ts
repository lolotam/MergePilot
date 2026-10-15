import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { Secret } from '@mergepilot/engine';
import { CursorWrites, loadRosters, rotationHandler } from './key-roster.js';
import type { ProcessReviewCredentials } from './types.js';

function loggerStub(): Logger {
  const warns: unknown[] = [];
  return {
    warn: (obj: unknown) => warns.push(obj),
    info: () => undefined,
    child: () => loggerStub(),
    _warns: warns,
  } as unknown as Logger & { _warns: unknown[] };
}

describe('loadRosters', () => {
  it('skips a failing fallback provider and logs without the secret', async () => {
    const secret = new Secret('fallback-secret-value-xyz');
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      resolveKeyRoster: vi.fn(async (_ws, provider) => {
        if (provider === 'openrouter') throw new Error(`cannot read ${secret.reveal()}`);
        return { secrets: [new Secret('primary-key-value-abc')], keyIds: ['k1'], startIndex: 0 };
      }),
    };
    const logger = loggerStub();
    const { rosters, keyIds } = await loadRosters(credentials, 'ws', ['gemini', 'openrouter'], 'gemini', logger);
    expect(Object.keys(rosters)).toEqual(['gemini']);
    expect(keyIds).toEqual({ gemini: ['k1'] });
    expect(JSON.stringify(logger._warns)).not.toContain(secret.reveal());
    expect(logger._warns[0]).toMatchObject({ event: 'credential.key_roster_failed', provider: 'openrouter' });
  });

  it('rethrows when the primary provider roster cannot be loaded', async () => {
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      resolveKeyRoster: vi.fn(async () => {
        throw new Error('primary vault unreadable');
      }),
    };
    const logger = loggerStub();
    await expect(loadRosters(credentials, 'ws', ['gemini', 'openrouter'], 'gemini', logger)).rejects.toThrow(
      'primary vault unreadable',
    );
  });
});

describe('rotationHandler roster snapshots', () => {
  it('maps success index to key ids from the handler snapshot, not a later load', async () => {
    const remembered: string[] = [];
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      resolveKeyRoster: vi
        .fn()
        .mockResolvedValueOnce({
          secrets: [new Secret('key-a'), new Secret('key-b')],
          keyIds: ['id-a', 'id-b'],
          startIndex: 0,
        })
        .mockResolvedValueOnce({
          secrets: [new Secret('key-b'), new Secret('key-a')],
          keyIds: ['id-b', 'id-a'],
          startIndex: 0,
        }),
      rememberSuccessfulKey: vi.fn(async (_ws, _provider, keyId) => {
        remembered.push(keyId);
      }),
    };
    const logger = loggerStub();
    const events: Array<{ provider: string; keyIndex: number; skipped: number }> = [];

    const first = await loadRosters(credentials, 'ws', ['openrouter'], 'openrouter', logger);
    const writes = new CursorWrites();
    const firstHandler = rotationHandler(events, credentials, 'ws', logger, first.keyIds, writes);
    firstHandler({ provider: 'openrouter', index: 1, skipped: 0 });
    await writes.flush();
    expect(remembered).toEqual(['id-b']);

    const second = await loadRosters(credentials, 'ws', ['openrouter'], 'openrouter', logger);
    const secondHandler = rotationHandler(events, credentials, 'ws', logger, second.keyIds, writes);
    secondHandler({ provider: 'openrouter', index: 1, skipped: 0 });
    await writes.flush();
    expect(remembered).toEqual(['id-b', 'id-a']);
  });
});

describe('CursorWrites', () => {
  it('runs queued cursor writes in order and flush waits for all of them, even after a failure', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      rememberSuccessfulKey: vi
        .fn()
        .mockImplementationOnce(async () => {
          await slow;
          order.push('first');
        })
        .mockImplementationOnce(async () => {
          throw new Error('cursor table unavailable');
        })
        .mockImplementationOnce(async () => {
          order.push('third');
        }),
    };
    const writes = new CursorWrites();
    const handler = rotationHandler([], credentials, 'ws', loggerStub(), { gemini: ['a', 'b', 'c'] }, writes);
    handler({ provider: 'gemini', index: 0, skipped: 0 });
    handler({ provider: 'gemini', index: 1, skipped: 1 });
    handler({ provider: 'gemini', index: 2, skipped: 2 });

    let flushed = false;
    const done = writes.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(false);

    release();
    await done;
    expect(order).toEqual(['first', 'third']);
  });
});


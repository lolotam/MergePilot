import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { Secret } from '@mergepilot/engine';
import { loadRosters } from './key-roster.js';
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
    const keyIds: Record<string, string[]> = {};
    const rosters = await loadRosters(
      credentials,
      'ws',
      ['gemini', 'openrouter'],
      'gemini',
      logger,
      keyIds,
    );
    expect(Object.keys(rosters)).toEqual(['gemini']);
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
    await expect(
      loadRosters(credentials, 'ws', ['gemini', 'openrouter'], 'gemini', logger, {}),
    ).rejects.toThrow('primary vault unreadable');
  });
});

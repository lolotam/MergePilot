import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';
import type { ProcessReviewCredentials } from './types.js';
import { loadRosters } from './key-roster.js';
import type { Logger } from 'pino';

function loggerStub(): Logger {
  return { warn: vi.fn(), info: vi.fn(), child: () => loggerStub() } as unknown as Logger;
}

describe('WorkspaceCredentialStore', () => {
  it('resolves api-key fallbacks from the roster instead of refreshing an expired subscription', async () => {
    const rosterSecret = new Secret('sk-fallback-roster-key-01');
    const resolve = vi.fn(async () => {
      throw new Error('Subscription token refresh failed; sign in again');
    });
    const credentials: ProcessReviewCredentials = {
      resolve,
      resolveKeyRoster: vi.fn(async () => ({
        secrets: [rosterSecret],
        keyIds: ['kid'],
        startIndex: 0,
      })),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key'),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', new Secret('primary-key-value-abc'));
    const resolved = await store.resolve({ provider: 'openai' }, 'fallback');
    expect(resolved.reveal()).toBe(rosterSecret.reveal());
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an api-key fallback without keys instead of using the subscription', async () => {
    const resolve = vi.fn(async () => new Secret('subscription-envelope-must-not-be-used'));
    const credentials: ProcessReviewCredentials = {
      resolve,
      resolveKeyRoster: vi.fn(async () => null),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', new Secret('primary-key-value-abc'));
    await expect(store.resolve({ provider: 'openai' }, 'fallback')).rejects.toThrow(/No API key is available/);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('loadRosters api-key fallbacks', () => {
  it('skips an empty api-key fallback roster while the primary still loads', async () => {
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      getEffectiveAuthMethod: vi.fn(async (_ws, provider) => (provider === 'openai' ? 'api-key' : 'api-key')),
      resolveKeyRoster: vi.fn(async (_ws, provider) =>
        provider === 'gemini'
          ? { secrets: [new Secret('primary-key-value-abc')], keyIds: ['p1'], startIndex: 0 }
          : null,
      ),
    };
    const { rosters } = await loadRosters(credentials, 'ws', ['gemini', 'openai'], 'gemini', loggerStub());
    expect(Object.keys(rosters)).toEqual(['gemini']);
  });
});

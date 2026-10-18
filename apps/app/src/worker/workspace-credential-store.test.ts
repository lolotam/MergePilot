import { describe, expect, it, vi } from 'vitest';
import { createReviewModel, encodeSubscription, LlmFailure, Secret, type MergePilotConfig } from '@mergepilot/engine';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';
import type { ProcessReviewCredentials } from './types.js';
import { loadRosters } from './key-roster.js';
import type { Logger } from 'pino';

function loggerStub(): Logger {
  return { warn: vi.fn(), info: vi.fn(), child: () => loggerStub() } as unknown as Logger;
}

describe('WorkspaceCredentialStore', () => {
  it('resolves api-key fallbacks from the roster instead of refreshing an expired subscription', async () => {
    const rosterSecret = new Secret(['sk', 'fallback', 'roster', 'key', '01'].join('-'));
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

  it('returns the subscription when asked by name, though API keys are the default, and redacts both', async () => {
    const primaryKey = new Secret('openai-default-api-key-001');
    const envelope = new Secret('mp-sub:openai:envelope-for-test');
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(async () => envelope),
      resolveKeyRoster: vi.fn(async () => ({ secrets: [primaryKey], keyIds: ['k1'], startIndex: 0 })),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'openai', primaryKey);

    expect(await store.resolve({ provider: 'openai' }, 'review')).toBe(primaryKey);
    expect(await store.resolve({ provider: 'openai', method: 'subscription' }, 'review')).toBe(envelope);
    expect(store.getKnownSecrets()).toEqual(expect.arrayContaining([primaryKey, envelope]));
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

describe('loadRosters behind a subscription default (ADR-0027)', () => {
  const roster = { secrets: [new Secret('openai-api-key-behind-sub')], keyIds: ['k1'], startIndex: 0 };
  const credentials = (keys: typeof roster | null): ProcessReviewCredentials => ({
    resolve: vi.fn(),
    getEffectiveAuthMethod: vi.fn(async () => 'subscription' as const),
    resolveKeyRoster: vi.fn(async () => keys),
  });

  it('loads the keys of a dual primary so they can follow its subscription', async () => {
    const { rosters } = await loadRosters(credentials(roster), 'ws', ['openai'], 'openai', loggerStub(), { openai: { defaultMethod: 'subscription' } });
    expect(rosters.openai?.keys).toEqual(roster.secrets);
  });

  it('leaves the keys out when the provider is not dual for this run', async () => {
    const creds = credentials(roster);
    const { rosters } = await loadRosters(creds, 'ws', ['openai'], 'openai', loggerStub());
    expect(rosters).toEqual({});
    expect(creds.resolveKeyRoster).not.toHaveBeenCalled();
  });

  it('does not fail the review when the keys behind a subscription primary are gone', async () => {
    const { rosters } = await loadRosters(credentials(null), 'ws', ['openai'], 'openai', loggerStub(), { openai: { defaultMethod: 'subscription' } });
    expect(rosters).toEqual({});
  });
});

describe('the worker store under createReviewModel (ADR-0027)', () => {
  it('builds the subscription behind an API-key default and redacts both methods', async () => {
    const key = new Secret('anthropic-default-api-key-001');
    const envelope = new Secret(
      encodeSubscription('anthropic', { type: 'oauth', access: 'anthropic-access-01', refresh: 'anthropic-refresh-01', expires: Date.now() + 3_600_000 }),
    );
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(async () => envelope),
      resolveKeyRoster: vi.fn(async () => ({ secrets: [key], keyIds: ['k1'], startIndex: 0 })),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', key);
    const config: MergePilotConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      language: 'en',
      review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [] },
      budget: { perReviewUsd: 0.5, maxInputTokens: 200_000 },
      audit: { enabled: false },
    };
    const model = await createReviewModel(config, store, {
      cwd: '/tmp',
      dualMethods: { anthropic: { defaultMethod: 'api-key' } },
      keyRosters: { anthropic: { keys: [key], startIndex: 0 } },
    });

    expect(model).toMatchObject({ authMethod: 'api-key' });
    expect(model.fallbacks?.[0]).toMatchObject({ authMethod: 'subscription', includedInSubscription: true });
    expect(model.secrets).toEqual(expect.arrayContaining([key, envelope]));
    expect(store.getKnownSecrets()).toEqual(expect.arrayContaining([key, envelope]));
  });
});

describe('a bot admitted free on its subscription (ADR-0033)', () => {
  const envelope = new Secret(
    encodeSubscription('anthropic', { type: 'oauth', access: 'anthropic-access-02', refresh: 'anthropic-refresh-02', expires: Date.now() + 3_600_000 }),
  );
  const key = new Secret('anthropic-api-key-after-admission');
  // An admin switched the default to API keys after the bot was admitted free.
  const switched = (parent: Secret): ProcessReviewCredentials => ({
    resolve: vi.fn(async () => parent),
    resolveKeyRoster: vi.fn(async () => ({ secrets: [key], keyIds: ['k1'], startIndex: 0 })),
    getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
  });

  it('keeps answering every resolve of its provider, refreshes included, with the subscription', async () => {
    const store = new WorkspaceCredentialStore('ws', switched(envelope), 'anthropic', envelope, { subscriptionOnlyProviders: new Set(['anthropic']) });
    const config: MergePilotConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      language: 'en',
      fallback: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }],
      review: { maxFindings: 5, minSeverity: 'medium', exclude: [], rulesFiles: [], pathInstructions: [] },
      budget: { perReviewUsd: 0.5, maxInputTokens: 200_000 },
      audit: { enabled: false },
    };
    const model = await createReviewModel(config, store, { cwd: '/tmp' });

    expect(model).toMatchObject({ includedInSubscription: true });
    expect(model.fallbacks).toEqual([expect.objectContaining({ includedInSubscription: true })]);
    expect(await store.resolve({ provider: 'anthropic' }, 'review')).toBe(envelope);
  });

  it('fails with an auth failure instead of sending the API key that replaced the subscription', async () => {
    const store = new WorkspaceCredentialStore('ws', switched(key), 'anthropic', envelope, { subscriptionOnlyProviders: new Set(['anthropic']) });

    const failure = await store.resolve({ provider: 'anthropic' }, 'review').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmFailure);
    expect(failure).toMatchObject({ code: 'INVALID_CREDENTIAL', provider: 'anthropic' });
    expect((failure as Error).message).not.toContain(key.reveal());
  });

  it('leaves other providers on their own effective method', async () => {
    const store = new WorkspaceCredentialStore('ws', switched(envelope), 'anthropic', envelope, { subscriptionOnlyProviders: new Set(['anthropic']) });

    expect(await store.resolve({ provider: 'openai' }, 'fallback')).toBe(key);
  });
});

describe('a free fallback provider stays on its admitted subscription (ADR-0035)', () => {
  const subscription = () => new Secret(encodeSubscription('openai', {
    type: 'oauth', access: 'fallback-access', refresh: 'fallback-refresh', expires: Date.now() + 3_600_000,
  }));

  it('pins every resolve, including refreshes and explicit method requests, after an API-key default switch', async () => {
    let parent = subscription();
    const credentials = {
      resolve: vi.fn(async () => parent),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
      resolveKeyRoster: vi.fn(),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', new Secret('primary'), {
      subscriptionOnlyProviders: new Set(['anthropic', 'openai']),
    });
    expect(await store.resolve({ provider: 'openai' }, 'review')).toBe(parent);
    parent = subscription();
    for (const method of [undefined, 'subscription', 'api-key'] as const) {
      expect(await store.resolve({ provider: 'openai', ...(method ? { method } : {}) }, 'review')).toBe(parent);
    }
    expect(credentials.getEffectiveAuthMethod).not.toHaveBeenCalled();
    expect(credentials.resolveKeyRoster).not.toHaveBeenCalled();
    expect(store.getKnownSecrets()).toContain(parent);
  });

  it('fails with INVALID_CREDENTIAL if the fallback subscription is replaced mid-run, without using its cached envelope or the new key', async () => {
    let parent = subscription();
    const credentials = {
      resolve: vi.fn(async () => parent),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key' as const),
      resolveKeyRoster: vi.fn(),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', new Secret('primary'), {
      subscriptionOnlyProviders: new Set(['anthropic', 'openai']),
    });
    await store.resolve({ provider: 'openai' }, 'review');
    parent = new Secret('replacement-key');
    for (const method of [undefined, 'subscription', 'api-key'] as const) {
      await expect(store.resolve({ provider: 'openai', ...(method ? { method } : {}) }, 'review'))
        .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL', provider: 'openai' });
    }
    expect(credentials.resolveKeyRoster).not.toHaveBeenCalled();
    expect(store.getKnownSecrets()).not.toContain(parent);
  });
});

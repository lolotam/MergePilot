import { describe, expect, it, vi } from 'vitest';
import { encodeSubscription, Secret } from '@mergepilot/engine';
import { addRedactionCredentials } from './redaction-credentials.js';
import { WorkspaceCredentialStore } from './workspace-credential-store.js';

const subscription = (provider: 'anthropic' | 'openai' | 'xai') => new Secret(encodeSubscription(provider, {
  type: 'oauth', access: `${provider}-access`, refresh: `${provider}-refresh`, expires: Date.now() + 3_600_000,
}));

describe('redaction-only credentials', () => {
  it('collects all rosters and non-primary parents once, independently of the effective method', async () => {
    const primary = subscription('anthropic');
    const parents = { anthropic: primary, openai: subscription('openai'), xai: subscription('xai') };
    const keys = [new Secret('new-primary-key'), new Secret('new-fallback-key')];
    const credentials = {
      resolve: vi.fn(async (_ws: string, provider: string) => parents[provider as keyof typeof parents]),
      resolveKeyRoster: vi.fn(async () => ({ secrets: keys, keyIds: ['one', 'two'], startIndex: 0 })),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', primary);
    await addRedactionCredentials(credentials, 'ws', ['anthropic', 'openai', 'xai', 'openai'], 'anthropic', store);
    expect(credentials.resolveKeyRoster).toHaveBeenCalledTimes(3);
    expect(credentials.resolve.mock.calls.map((call) => call[1])).toEqual(['openai', 'xai']);
    expect(store.getKnownSecrets()).toEqual(expect.arrayContaining([primary, ...keys, parents.openai, parents.xai]));
  });

  it.each(['roster', 'parent', 'both'] as const)('keeps available secrets when the %s read fails', async (failure) => {
    const primary = subscription('anthropic');
    const parent = subscription('openai');
    const key = new Secret('available-key');
    const credentials = {
      resolve: vi.fn(async () => {
        if (failure !== 'roster') throw new Error('parent unavailable');
        return parent;
      }),
      resolveKeyRoster: vi.fn(async () => {
        if (failure !== 'parent') throw new Error('roster unavailable');
        return { secrets: [key], keyIds: ['one'], startIndex: 0 };
      }),
    };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', primary);
    await expect(addRedactionCredentials(credentials, 'ws', ['openai'], 'anthropic', store)).resolves.toBeUndefined();
    expect(credentials.resolve).toHaveBeenCalledTimes(1);
    expect(store.getKnownSecrets()).toEqual(failure === 'roster' ? [primary, parent] : failure === 'parent' ? [primary, key] : [primary]);
  });

  it('still reads the parent when the optional roster API is absent', async () => {
    const primary = subscription('anthropic');
    const parent = subscription('openai');
    const credentials = { resolve: vi.fn(async () => parent) };
    const store = new WorkspaceCredentialStore('ws', credentials, 'anthropic', primary);
    await addRedactionCredentials(credentials, 'ws', ['openai'], 'anthropic', store);
    expect(store.getKnownSecrets()).toEqual([primary, parent]);
  });
});

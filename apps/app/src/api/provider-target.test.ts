import { describe, expect, it, vi } from 'vitest';
import type { SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from '../credentials/service.js';
import { catalogTarget, storedTarget } from './provider-target.js';

const subCredential = (): SubscriptionCredential => ({
  type: 'oauth',
  access: ['test', 'access', '1111'].join('-'),
  refresh: ['test', 'refresh'].join('-'),
  expires: Date.now() + 3_600_000,
});

describe('storedTarget (ADR-0027)', () => {
  it('uses the API key roster when the effective default is api-key on a dual provider', async () => {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(Buffer.alloc(32, 3).toString('base64'));
    const credentials = new CredentialService({ store, vault });
    await credentials.saveSubscription('ws', 'anthropic', subCredential(), 'u');
    await credentials.appendProviderKey({
      workspaceId: 'ws',
      provider: 'anthropic',
      apiKey: ['sk', 'ant', 'api', 'target', '4242'].join('-'),
      userId: 'u',
    });
    await credentials.setProviderDefaultMethod('ws', 'anthropic', 'api-key');

    const resolve = vi.spyOn(credentials, 'resolve');
    const result = await storedTarget({ store, credentials }, 'ws', 'anthropic');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.target.apiKey).toBe(['sk', 'ant', 'api', 'target', '4242'].join('-'));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the active roster key for an API-key-only provider', async () => {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(Buffer.alloc(32, 5).toString('base64'));
    const credentials = new CredentialService({ store, vault });
    const provider = 'openrouter';
    const key = (suffix: string) => ['test', 'roster', 'key', suffix].join('-');
    await credentials.appendProviderKey({ workspaceId: 'ws', provider, apiKey: key('first'), userId: 'u' });
    await credentials.appendProviderKey({ workspaceId: 'ws', provider, apiKey: key('second'), userId: 'u' });
    const slots = await store.listProviderKeys('ws', provider);
    await store.setKeyCursor('ws', provider, slots[1]!.id);
    await store.modifyProviderKeys('ws', provider, async (current) => ({
      keys: current.map((slot, i) => i === 0 ? { ...slot, ciphertext: 'unreadable' } : slot),
    }));
    expect(await storedTarget({ store, credentials }, 'ws', provider))
      .toMatchObject({ ok: true, target: { apiKey: key('second'), slotId: slots[1]!.id } });
  });

  it('resolves the subscription envelope when the effective default is subscription', async () => {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(Buffer.alloc(32, 4).toString('base64'));
    const credentials = new CredentialService({ store, vault });
    await credentials.saveSubscription('ws', 'openai', subCredential(), 'u');
    const resolveKeyRoster = vi.spyOn(credentials, 'resolveKeyRoster');
    const result = await storedTarget({ store, credentials }, 'ws', 'openai');
    expect(result.ok).toBe(true);
    expect(resolveKeyRoster).not.toHaveBeenCalled();
    if (result.ok) expect(result.target.apiKey).toContain('mergepilot:oauth');
  });
});

describe('catalogTarget', () => {
  const setup = async (provider: 'openai' | 'anthropic', withKey: boolean) => {
    const store = new MemoryStore();
    const credentials = new CredentialService({ store, vault: new EnvelopeVault(Buffer.alloc(32, 6).toString('base64')) });
    await credentials.saveSubscription('ws', provider, subCredential(), 'u');
    if (withKey) await credentials.appendProviderKey({ workspaceId: 'ws', provider, apiKey: ['test', 'catalog', 'key'].join('-'), userId: 'u' });
    return { deps: { store, credentials }, credentials };
  };

  it('adds the OpenAI API key next to a Codex sign-in, and leaves storedTarget on the sign-in alone', async () => {
    const { deps } = await setup('openai', true);
    expect(await catalogTarget(deps, 'ws', 'openai')).toMatchObject({ ok: true, target: { catalogApiKey: ['test', 'catalog', 'key'].join('-'), slotId: expect.any(String) } });
    const plain = await storedTarget(deps, 'ws', 'openai');
    expect(plain.ok && plain.target.catalogApiKey).toBeFalsy();
  });

  it('adds nothing without an API key, for other providers, or when the roster cannot be read', async () => {
    const none = await setup('openai', false);
    const noKey = await catalogTarget(none.deps, 'ws', 'openai');
    expect(noKey.ok && noKey.target.catalogApiKey).toBeUndefined();

    const claude = await setup('anthropic', true);
    const roster = vi.spyOn(claude.credentials, 'resolveKeyRoster');
    const other = await catalogTarget(claude.deps, 'ws', 'anthropic');
    expect(other.ok && other.target.catalogApiKey).toBeUndefined();
    expect(roster).not.toHaveBeenCalled();

    const broken = await setup('openai', true);
    vi.spyOn(broken.credentials, 'resolveKeyRoster').mockRejectedValue(new Error('vault unavailable'));
    expect(await catalogTarget(broken.deps, 'ws', 'openai')).toMatchObject({ ok: true });
    const result = await catalogTarget(broken.deps, 'ws', 'openai');
    expect(result.ok && result.target.catalogApiKey).toBeUndefined();
  });
});

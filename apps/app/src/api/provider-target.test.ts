import { describe, expect, it, vi } from 'vitest';
import type { SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from '../credentials/service.js';
import { storedTarget } from './provider-target.js';

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
      apiKey: 'sk-ant-api-target-4242',
      userId: 'u',
    });
    await credentials.setProviderDefaultMethod('ws', 'anthropic', 'api-key');

    const resolve = vi.spyOn(credentials, 'resolve');
    const result = await storedTarget({ store, credentials }, 'ws', 'anthropic');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.target.apiKey).toBe('sk-ant-api-target-4242');
    expect(resolve).not.toHaveBeenCalled();
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

import { describe, expect, it } from 'vitest';
import { encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import {
  CredentialService,
  SubscriptionEnvelopeInKeyListError,
  UnavailableAuthMethodError,
  UnreadableCredentialError,
} from './service.js';

const credential = (expires = Date.now() + 3_600_000): SubscriptionCredential => ({
  type: 'oauth', access: ['test', 'access', '1111'].join('-'), refresh: ['test', 'refresh'].join('-'), expires,
});

function fixture() {
  const store = new MemoryStore();
  const vault = new EnvelopeVault(Buffer.alloc(32, 9).toString('base64'));
  return { store, vault, service: new CredentialService({ store, vault }) };
}

describe('dual-method providers (ADR-0027 phase A)', () => {
  it('materialises a legacy API-key parent written with saveCredential on first append', async () => {
    const { service, store, vault } = fixture();
    const apiKey = ['sk', 'legacy', 'parent', '0001'].join('-');
    const sealed = await vault.encrypt(apiKey, { workspaceId: 'ws', provider: 'openai' });
    await store.saveCredential({
      id: 'legacy-parent',
      workspaceId: 'ws',
      provider: 'openai',
      ciphertext: sealed,
      keyVersion: 1,
      last4: '0001',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'openai', apiKey: ['sk', 'second', 'key', '0002'].join('-'), userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'openai');
    expect(slots).toHaveLength(2);
    expect(slots[0]?.last4).toBe('0001');
    expect(slots[1]?.last4).toBe('0002');
    expect((await store.getCredential('ws', 'openai'))?.last4).toBe('0001');
  });

  it('fail-closed: unreadable parent throws UnreadableCredentialError inside modifyProviderKeys', async () => {
    const { service, store } = fixture();
    await store.saveCredential({
      id: 'bad-parent',
      workspaceId: 'ws',
      provider: 'anthropic',
      ciphertext: 'not-valid-ciphertext',
      keyVersion: 1,
      last4: 'bad1',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    await expect(
      service.appendProviderKey({ workspaceId: 'ws', provider: 'anthropic', apiKey: ['sk', 'ant', 'api', '0001'].join('-'), userId: 'u' }),
    ).rejects.toBeInstanceOf(UnreadableCredentialError);
    expect(await store.listProviderKeys('ws', 'anthropic')).toHaveLength(0);
  });

  it('keeps the key cursor when appending to an existing list', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'xai', credential(), 'u');
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['xai', 'key', '00000001'].join('-'), userId: 'u' });
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['xai', 'key', '00000002'].join('-'), userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'xai');
    await store.setKeyCursor('ws', 'xai', slots[1]!.id);
    expect(await store.getKeyCursor('ws', 'xai')).toBe(1);
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['xai', 'key', '00000003'].join('-'), userId: 'u' });
    expect(await store.getKeyCursor('ws', 'xai')).toBe(1);
  });

  it('saveSubscription replaces a legacy API-key parent while materialising slots', async () => {
    const { service, store, vault } = fixture();
    const apiKey = ['sk', 'legacy', 'before', 'sub', '0001'].join('-');
    const sealed = await vault.encrypt(apiKey, { workspaceId: 'ws', provider: 'openai' });
    await store.saveCredential({
      id: 'legacy-openai',
      workspaceId: 'ws',
      provider: 'openai',
      ciphertext: sealed,
      keyVersion: 1,
      last4: '0001',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    await service.saveSubscription('ws', 'openai', credential(), 'u');
    expect(await store.listProviderKeys('ws', 'openai')).toHaveLength(1);
    expect((await store.getCredential('ws', 'openai'))?.last4).toBe('1111');
    const roster = await service.resolveKeyRoster('ws', 'openai');
    expect(roster?.secrets[0]?.reveal()).toBe(apiKey);
  });

  it('rejects a subscription envelope written into the API key slot list', async () => {
    const { service } = fixture();
    const envelope = encodeSubscription('openai', credential());
    await expect(
      service.appendProviderKey({ workspaceId: 'ws', provider: 'openai', apiKey: envelope, userId: 'u' }),
    ).rejects.toBeInstanceOf(SubscriptionEnvelopeInKeyListError);
  });

  it('materialises a sealed legacy parent as slot 0 on append without using saveKey', async () => {
    const { service, store, vault } = fixture();
    const apiKey = ['sk', 'sealed', 'parent', '0001'].join('-');
    const sealed = await vault.encrypt(apiKey, { workspaceId: 'ws', provider: 'openai' });
    await store.saveCredential({
      id: 'openai-parent',
      workspaceId: 'ws',
      provider: 'openai',
      ciphertext: sealed,
      keyVersion: 1,
      last4: '0001',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    expect(await store.listProviderKeys('ws', 'openai')).toHaveLength(0);
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'openai', apiKey: ['sk', 'second', 'openai', '02'].join('-'), userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'openai');
    expect(slots).toHaveLength(2);
    expect(slots[0]?.last4).toBe('0001');
    expect((await service.resolveKeyRoster('ws', 'openai'))?.secrets[0]?.reveal()).toBe(apiKey);
  });

  it('saveSubscription materialises a legacy API-key parent into slot 0', async () => {
    const { service, store, vault } = fixture();
    const apiKey = ['sk', 'legacy', 'before', 'sub', '0001'].join('-');
    const sealed = await vault.encrypt(apiKey, { workspaceId: 'ws', provider: 'anthropic' });
    await store.saveCredential({
      id: 'legacy-anthropic',
      workspaceId: 'ws',
      provider: 'anthropic',
      ciphertext: sealed,
      keyVersion: 1,
      last4: '0001',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    await service.saveSubscription('ws', 'anthropic', credential(), 'u');
    expect(await store.listProviderKeys('ws', 'anthropic')).toHaveLength(1);
    expect((await service.resolveKeyRoster('ws', 'anthropic'))?.secrets[0]?.reveal()).toBe(apiKey);
  });

  it('connecting a subscription keeps existing key slots', async () => {
    const { service, store } = fixture();
    await service.saveKey({ workspaceId: 'ws', provider: 'anthropic', apiKey: ['sk', 'ant', 'api', '0001'].join('-'), userId: 'u' });
    await service.saveSubscription('ws', 'anthropic', credential(), 'u');
    expect(await store.listProviderKeys('ws', 'anthropic')).toHaveLength(1);
    const parent = await store.getCredential('ws', 'anthropic');
    expect(parent?.last4).toBe('1111');
  });

  it('disconnect rewrites the parent from slot 0', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'xai', credential(), 'u');
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['xai', 'key', '00000001'].join('-'), userId: 'u' });
    await service.disconnectSubscription('ws', 'xai');
    const parent = await store.getCredential('ws', 'xai');
    expect(parent?.last4).toBe('0001');
    const value = await service.resolve('ws', 'xai');
    expect(value.reveal()).toBe(['xai', 'key', '00000001'].join('-'));
  });

  it('deleting the last API key keeps a subscription parent', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'openai', credential(), 'u');
    const slot = await service.appendProviderKey({ workspaceId: 'ws', provider: 'openai', apiKey: ['sk', 'openai', '0001'].join('-'), userId: 'u' });
    await service.deleteProviderKey('ws', 'openai', slot.id);
    expect(await store.listProviderKeys('ws', 'openai')).toHaveLength(0);
    expect((await store.getCredential('ws', 'openai'))?.last4).toBe('1111');
  });

  it('resolveKeyRoster never returns the subscription envelope', async () => {
    const { service } = fixture();
    await service.saveSubscription('ws', 'anthropic', credential(), 'u');
    expect(await service.resolveKeyRoster('ws', 'anthropic')).toBeNull();
  });

  it('refuses a default method that has no credential', async () => {
    const { service } = fixture();
    await service.saveSubscription('ws', 'openai', credential(), 'u');
    await expect(service.setProviderDefaultMethod('ws', 'openai', 'api-key')).rejects.toBeInstanceOf(UnavailableAuthMethodError);
  });

  it('falls back when the stored preference method is gone', async () => {
    const { service, store } = fixture();
    await service.saveKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['xai', 'key', '00000001'].join('-'), userId: 'u' });
    await store.setProviderAuthPreference('ws', 'xai', 'subscription');
    expect(await service.getEffectiveAuthMethod('ws', 'xai')).toBe('api-key');
  });

  it('never switches an unreadable parent to the API keys unless API keys were chosen', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'anthropic', credential(), 'u');
    await service.appendProviderKey({ workspaceId: 'ws', provider: 'anthropic', apiKey: ['sk', 'ant', 'api', 'key', '0001'].join('-'), userId: 'u' });
    const parent = await store.getCredential('ws', 'anthropic');
    await store.saveCredential({ ...parent!, ciphertext: 'not-a-valid-envelope' });
    await store.setProviderAuthPreference('ws', 'anthropic', 'subscription');
    expect(await service.getEffectiveAuthMethod('ws', 'anthropic')).toBeNull();
    await store.setProviderAuthPreference('ws', 'anthropic', 'api-key');
    expect(await service.getEffectiveAuthMethod('ws', 'anthropic')).toBe('api-key');
  });
});

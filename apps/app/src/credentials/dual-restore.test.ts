import { describe, expect, it } from 'vitest';
import { encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { dualProviderRestoreChange, type DualProviderRestorePlan } from './dual-restore.js';
import { CredentialService } from './service.js';

const subCredential = (): SubscriptionCredential => ({
  type: 'oauth',
  access: ['test', 'access', '1111'].join('-'),
  refresh: ['test', 'refresh'].join('-'),
  expires: Date.now() + 3_600_000,
});

function fixture() {
  const store = new MemoryStore();
  const vault = new EnvelopeVault(Buffer.alloc(32, 3).toString('base64'));
  const service = new CredentialService({ store, vault });
  return { store, vault, service };
}

describe('dualProviderRestoreChange (restore-only, R2/R3)', () => {
  it('subscription with explicit keys ignores an unreadable current parent', async () => {
    const { store, vault } = fixture();
    await store.saveCredential({
      id: 'bad',
      workspaceId: 'ws',
      provider: 'openai',
      ciphertext: 'not-valid',
      keyVersion: 1,
      last4: 'bad1',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    });
    const fileKey = 'sk-file-key-00000001';
    const sealed = await vault.encrypt(fileKey, { workspaceId: 'ws', provider: 'openai' });
    const plan: DualProviderRestorePlan = {
      provider: 'openai',
      subscriptionParent: {
        id: 'sub',
        workspaceId: 'ws',
        provider: 'openai',
        ciphertext: await vault.encrypt(encodeSubscription('openai', subCredential()), { workspaceId: 'ws', provider: 'openai' }),
        keyVersion: 1,
        last4: '1111',
        createdBy: 'u',
        createdAt: new Date(),
        baseUrl: null,
      },
      keys: [
        {
          id: 'slot0',
          workspaceId: 'ws',
          provider: 'openai',
          position: 0,
          ciphertext: sealed,
          keyVersion: 1,
          last4: '0001',
          createdBy: 'u',
          createdAt: new Date(),
          lastTestStatus: null,
          lastTestedAt: null,
        },
      ],
      defaultMethod: 'api-key',
      subscriptionParentFromFile: true,
      keysFieldPresent: true,
    };
    const change = await dualProviderRestoreChange(vault, plan, [], await store.getCredential('ws', 'openai'));
    expect(change.keys).toHaveLength(1);
    expect(change.parent?.last4).toBe('1111');
  });

  it('subscription without keys materialises only when the current parent is readable', async () => {
    const { store, vault, service } = fixture();
    const legacy = 'sk-legacy-readable-01';
    await service.saveKey({ workspaceId: 'ws', provider: 'anthropic', apiKey: legacy, userId: 'u' });
    const parent = await store.getCredential('ws', 'anthropic');
    const plan: DualProviderRestorePlan = {
      provider: 'anthropic',
      subscriptionParent: {
        id: 'sub',
        workspaceId: 'ws',
        provider: 'anthropic',
        ciphertext: await vault.encrypt(encodeSubscription('anthropic', subCredential()), { workspaceId: 'ws', provider: 'anthropic' }),
        keyVersion: 1,
        last4: '1111',
        createdBy: 'u',
        createdAt: new Date(),
        baseUrl: null,
      },
      keys: [],
      defaultMethod: 'subscription',
      subscriptionParentFromFile: true,
      keysFieldPresent: false,
    };
    const readable = await dualProviderRestoreChange(vault, plan, await store.listProviderKeys('ws', 'anthropic'), parent);
    expect(readable.keys).toHaveLength(1);
    await store.saveCredential({ ...parent!, ciphertext: 'garbage' });
    const unreadable = await dualProviderRestoreChange(vault, plan, [], await store.getCredential('ws', 'anthropic'));
    expect(unreadable.keys).toHaveLength(0);
  });

  it('keys-only keeps a readable subscription parent and mirrors when it is unreadable', async () => {
    const { store, vault, service } = fixture();
    await service.saveSubscription('ws', 'xai', subCredential(), 'u');
    const fileKey = 'xai-file-key-000001';
    const sealed = await vault.encrypt(fileKey, { workspaceId: 'ws', provider: 'xai' });
    const keys = [
      {
        id: 'k0',
        workspaceId: 'ws',
        provider: 'xai',
        position: 0,
        ciphertext: sealed,
        keyVersion: 1,
        last4: '0001',
        createdBy: 'u',
        createdAt: new Date(),
        lastTestStatus: null,
        lastTestedAt: null,
      },
    ];
    const plan: DualProviderRestorePlan = {
      provider: 'xai',
      subscriptionParent: null,
      keys,
      defaultMethod: null,
      subscriptionParentFromFile: false,
      keysFieldPresent: true,
    };
    const keep = await dualProviderRestoreChange(vault, plan, [], await store.getCredential('ws', 'xai'));
    expect(keep.parent).toBeUndefined();
    await store.modifyProviderKeys('ws', 'xai', async () => keep);
    expect((await store.getCredential('ws', 'xai'))?.last4).toBe('1111');
    await store.saveCredential({
      ...(await store.getCredential('ws', 'xai'))!,
      ciphertext: 'broken',
    });
    const mirror = await dualProviderRestoreChange(vault, plan, [], await store.getCredential('ws', 'xai'));
    expect(mirror.parent?.last4).toBe('0001');
  });

  it('treats keys: [] differently from an absent keys field', async () => {
    const { vault } = fixture();
    const parent = {
      id: 'sub',
      workspaceId: 'ws',
      provider: 'openai',
      ciphertext: await vault.encrypt(encodeSubscription('openai', subCredential()), { workspaceId: 'ws', provider: 'openai' }),
      keyVersion: 1,
      last4: '1111',
      createdBy: 'u',
      createdAt: new Date(),
      baseUrl: null,
    };
    const absent = await dualProviderRestoreChange(vault, {
      provider: 'openai',
      subscriptionParent: parent,
      keys: [],
      defaultMethod: null,
      subscriptionParentFromFile: true,
      keysFieldPresent: false,
    }, [{ id: 'old', workspaceId: 'ws', provider: 'openai', position: 0, ciphertext: 'x', keyVersion: 1, last4: 'old1', createdBy: 'u', createdAt: new Date(), lastTestStatus: null, lastTestedAt: null }], parent);
    expect(absent.keys).toHaveLength(1);
    const empty = await dualProviderRestoreChange(vault, {
      provider: 'openai',
      subscriptionParent: parent,
      keys: [],
      defaultMethod: null,
      subscriptionParentFromFile: true,
      keysFieldPresent: true,
    }, [{ id: 'old', workspaceId: 'ws', provider: 'openai', position: 0, ciphertext: 'x', keyVersion: 1, last4: 'old1', createdBy: 'u', createdAt: new Date(), lastTestStatus: null, lastTestedAt: null }], parent);
    expect(empty.keys).toHaveLength(0);
  });
});

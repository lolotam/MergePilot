import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSubscription, encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from './service.js';

const credential = (expires = Date.now() + 3_600_000): SubscriptionCredential => ({
  type: 'oauth', access: ['test', 'access', '1111'].join('-'), refresh: ['test', 'refresh'].join('-'), expires,
});
const fakeValue = (...parts: string[]) => parts.join('-');
function fixture() {
  const store = new MemoryStore();
  const vault = new EnvelopeVault(Buffer.alloc(32, 7).toString('base64'));
  return { store, vault, service: new CredentialService({ store, vault }) };
}
afterEach(() => vi.unstubAllGlobals());

describe('workspace subscription credentials', () => {
  it('bounds expired refreshes to two active transactions while fresh reads use no transaction', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('fresh', 'xai', credential(), 'user');
    const modify = vi.spyOn(store, 'modifyCredential');
    await service.resolve('fresh', 'xai');
    expect(modify).not.toHaveBeenCalled();
    for (const workspaceId of ['one', 'two', 'three']) await service.saveSubscription(workspaceId, 'xai', credential(0), 'user');
    modify.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      await gate;
      active--;
      return Response.json({ access_token: fakeValue('new', 'access'), refresh_token: fakeValue('new', 'refresh'), expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const reads = Promise.all(['one', 'two', 'three'].map((workspaceId) => service.resolve(workspaceId, 'xai')));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(modify).toHaveBeenCalledTimes(2);
    release();
    await reads;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximum).toBe(2);
  });
  it('keeps malformed or undecryptable credentials visible for deletion without claiming subscription pricing', async () => {
    const { service, store, vault } = fixture();
    await service.saveSubscription('ws', 'openai', credential(), 'user');
    await service.saveKey({ workspaceId: 'ws', provider: 'xai', apiKey: fakeValue('test', 'api', 'key'), userId: 'user' });
    const stored = (await store.getCredential('ws', 'openai'))!;
    await store.saveCredential({ ...stored, ciphertext: 'invalid-ciphertext' });
    expect(await service.listKeys('ws')).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', authMethod: 'unknown' }),
      expect.objectContaining({ provider: 'xai', authMethod: 'api-key' }),
    ]));
    const malformed = await vault.encrypt('mergepilot:oauth:v1:invalid', { workspaceId: 'ws', provider: 'openai' });
    await store.saveCredential({ ...stored, ciphertext: malformed });
    expect((await service.listKeys('ws')).find((key) => key.provider === 'openai')?.authMethod).toBe('unknown');
    await service.deleteKey('ws', 'openai');
    expect(await store.getCredential('ws', 'openai')).toBeNull();
  });
  it.each(['openai', 'anthropic', 'xai'] as const)('encrypts %s tokens and exposes only method metadata', async (provider) => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', provider, credential(), 'user');
    const stored = (await store.getCredential('ws', provider))!;
    expect(stored.ciphertext).not.toContain(credential().access);
    const keys = await service.listKeys('ws');
    expect(keys[0]).toMatchObject({ authMethod: 'subscription', provider, last4: '1111' });
    expect(JSON.stringify(keys)).not.toContain(credential().refresh);
    const secret = await service.resolve('ws', provider);
    expect(decodeSubscription(secret.reveal(), provider)?.credential.access).toBe(credential().access);
    await service.saveKey({ workspaceId: 'ws', provider, userId: 'user', apiKey: fakeValue('test', 'api', 'key', '2222') });
    expect((await service.listKeys('ws'))[0]?.authMethod).toBe('api-key');
    expect((await service.resolve('ws', provider)).reveal()).toBe('test-api-key-2222');
  });

  it('rotates expired tokens once for concurrent service instances and persists the new refresh token', async () => {
    const { service, store, vault } = fixture();
    const other = new CredentialService({ store, vault });
    await service.saveSubscription('ws', 'xai', credential(0), 'user');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ access_token: fakeValue('rotated', 'access'), refresh_token: fakeValue('rotated', 'refresh'), expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const values = await Promise.all([service.resolve('ws', 'xai'), other.resolve('ws', 'xai')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.map((secret) => decodeSubscription(secret.reveal())?.credential.refresh)).toEqual(['rotated-refresh', 'rotated-refresh']);
    const row = (await store.getCredential('ws', 'xai'))!;
    expect(decodeSubscription(await vault.decrypt(row.ciphertext, { workspaceId: 'ws', provider: 'xai' }))?.credential.refresh).toBe('rotated-refresh');
  });

  it('preserves the encrypted credential on refresh failure and returns no provider response tokens', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'xai', credential(0), 'user');
    const before = (await store.getCredential('ws', 'xai'))!.ciphertext;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant', error_description: credential().refresh }, { status: 401 })));
    await expect(service.resolve('ws', 'xai')).rejects.toThrow('Subscription token refresh failed; sign in again');
    expect((await store.getCredential('ws', 'xai'))!.ciphertext).toBe(before);
  });

  it('rejects OAuth envelopes in the API-key path and mismatched provider backup restores', async () => {
    const { service } = fixture();
    const encoded = encodeSubscription('openai', credential());
    await expect(service.saveKey({ workspaceId: 'ws', provider: 'openai', apiKey: encoded, userId: 'u' })).rejects.toThrow(/subscription sign-in/);
    await expect(service.sealKey({ workspaceId: 'ws', provider: 'xai', apiKey: encoded, userId: 'u' }, { validate: false })).rejects.toThrow(/Invalid subscription credential/);
  });

  it('serializes disconnect after a pending refresh so the credential is not recreated', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', 'xai', credential(0), 'user');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => { await waiting; return Response.json({ access_token: fakeValue('next', 'access'), refresh_token: fakeValue('next', 'refresh'), expires_in: 3600 }); });
    vi.stubGlobal('fetch', fetchMock);
    const resolve = service.resolve('ws', 'xai');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const disconnect = service.deleteKey('ws', 'xai');
    release();
    await Promise.all([resolve, disconnect]);
    expect(await store.getCredential('ws', 'xai')).toBeNull();
  });
});

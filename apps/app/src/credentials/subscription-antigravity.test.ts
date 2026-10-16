import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_CLIENT_ID_ENV,
  ANTIGRAVITY_CLIENT_SECRET_ENV,
  decodeSubscription,
  encodeSubscription,
  redactSecrets,
  type SubscriptionCredential,
} from '@mergepilot/engine';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { reencryptAll } from '../vault/rotate.js';
import { CredentialService } from './service.js';

const PROVIDER = 'google-antigravity';
const fakeValue = (...parts: string[]) => parts.join('-');
const credential = (expires = Date.now() + 3_600_000): SubscriptionCredential => ({
  type: 'oauth', access: fakeValue('google', 'access', '1111'), refresh: fakeValue('google', 'refresh'), expires, projectId: 'project-1', tier: 'free-tier',
});

function fixture() {
  const store = new MemoryStore();
  const vault = new EnvelopeVault(Buffer.alloc(32, 9).toString('base64'));
  return { store, vault, service: new CredentialService({ store, vault }) };
}

beforeEach(() => {
  vi.stubEnv(ANTIGRAVITY_CLIENT_ID_ENV, 'fake-client-id');
  vi.stubEnv(ANTIGRAVITY_CLIENT_SECRET_ENV, 'fake-client-secret');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Google Antigravity credentials', () => {
  it('stores one encrypted envelope and lists it as a subscription with no tokens', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', PROVIDER, credential(), 'user');
    const stored = (await store.getCredential('ws', PROVIDER))!;
    expect(stored.ciphertext).not.toContain(credential().access);
    const keys = await service.listKeys('ws');
    expect(keys).toEqual([expect.objectContaining({ provider: PROVIDER, authMethod: 'subscription', last4: '1111' })]);
    expect(keys[0]).not.toHaveProperty('hasSubscription');
    expect(JSON.stringify(keys)).not.toContain(credential().refresh);
    expect(await store.listProviderKeys('ws', PROVIDER)).toEqual([]);
  });

  it('accepts no API key, including from a backup restore', async () => {
    const { service } = fixture();
    const apiKey = fakeValue('AIza', 'fake', 'key', '0000');
    await expect(service.saveKey({ workspaceId: 'ws', provider: PROVIDER, apiKey, userId: 'u' })).rejects.toThrow(/no API keys/);
    await expect(service.sealKey({ workspaceId: 'ws', provider: PROVIDER, apiKey, userId: 'u' }, { validate: false })).rejects.toThrow(/no API keys/);
    const restored = await service.sealKey({ workspaceId: 'ws', provider: PROVIDER, apiKey: encodeSubscription(PROVIDER, credential()), userId: 'u' }, { validate: false });
    expect(restored.provider).toBe(PROVIDER);
  });

  it('refreshes once for two service instances, keeps the refresh token and project, and stores the new token', async () => {
    const { service, store, vault } = fixture();
    const other = new CredentialService({ store, vault });
    await service.saveSubscription('ws', PROVIDER, credential(0), 'user');
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('fake-client-id');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ access_token: fakeValue('new', 'access'), expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const values = await Promise.all([service.resolve('ws', PROVIDER), other.resolve('ws', PROVIDER)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const value of values) {
      expect(decodeSubscription(value.reveal(), PROVIDER)?.credential).toMatchObject({ access: 'new-access', refresh: credential().refresh, projectId: 'project-1' });
    }
    const row = (await store.getCredential('ws', PROVIDER))!;
    expect(decodeSubscription(await vault.decrypt(row.ciphertext, { workspaceId: 'ws', provider: PROVIDER }))?.credential.access).toBe('new-access');
  });

  it('keeps the stored credential when Google rejects the refresh, without its body', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', PROVIDER, credential(0), 'user');
    const before = (await store.getCredential('ws', PROVIDER))!.ciphertext;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant', error_description: credential().refresh }, { status: 400 })));
    const failure = await service.resolve('ws', PROVIDER).catch((error: unknown) => error as Error);
    expect(failure.message).toBe('Subscription token refresh failed; sign in again');
    expect(failure.message).not.toContain(credential().refresh);
    expect((await store.getCredential('ws', PROVIDER))!.ciphertext).toBe(before);
  });

  it('serializes disconnect after a pending refresh so the credential is not recreated', async () => {
    const { service, store } = fixture();
    await service.saveSubscription('ws', PROVIDER, credential(0), 'user');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => { await waiting; return Response.json({ access_token: fakeValue('next', 'access'), expires_in: 3600 }); });
    vi.stubGlobal('fetch', fetchMock);
    const resolve = service.resolve('ws', PROVIDER);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const disconnect = service.deleteKey('ws', PROVIDER);
    release();
    await Promise.all([resolve, disconnect]);
    expect(await store.getCredential('ws', PROVIDER)).toBeNull();
  });

  it('re-encrypts the envelope on master-key rotation', async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const vaultV1 = new EnvelopeVault({ current: 1, keys: new Map([[1, key1]]) });
    const vaultV2 = new EnvelopeVault({ current: 2, keys: new Map([[1, key1], [2, key2]]) });
    const onlyV2 = new EnvelopeVault({ current: 2, keys: new Map([[2, key2]]) });
    const store = new MemoryStore();
    await new CredentialService({ store, vault: vaultV1 }).saveSubscription('ws', PROVIDER, credential(), 'u');
    expect(await reencryptAll(store, vaultV2, ['ws'])).toMatchObject({ reencrypted: 1 });
    const row = (await store.getCredential('ws', PROVIDER))!;
    expect(decodeSubscription(await onlyV2.decrypt(row.ciphertext, { workspaceId: 'ws', provider: PROVIDER }), PROVIDER)?.credential.projectId).toBe('project-1');
  });

  it('redacts the individual tokens of the envelope', async () => {
    const { service } = fixture();
    await service.saveSubscription('ws', PROVIDER, credential(), 'user');
    const secret = await service.resolve('ws', PROVIDER);
    const text = `failed with ${credential().access} and ${credential().refresh}`;
    const redacted = redactSecrets(text, [secret]).text;
    expect(redacted).not.toContain(credential().access);
    expect(redacted).not.toContain(credential().refresh);
  });
});

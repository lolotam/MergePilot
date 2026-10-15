import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeSubscription, type SubscriptionCredential } from '@mergepilot/engine';
import {
  createBackupHarness,
  exportBackup,
  fakeKey,
  PASSPHRASE,
  restoreBackup,
  type BackupHarness,
} from './backup-routes.fixtures.js';

const subCredential = (): SubscriptionCredential => ({
  type: 'oauth',
  access: ['test', 'access', '1111'].join('-'),
  refresh: ['test', 'refresh'].join('-'),
  expires: Date.now() + 3_600_000,
});

describe('settings backup: dual-method restore (ADR-0027)', { timeout: 60000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
  }, 60000);

  afterEach(async () => {
    await h.close();
  });

  const keys = async (ws: string) =>
    (
      await h.app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/keys`,
        headers: { cookie: h.cookie('owner') },
      })
    ).json() as { keys: Array<Record<string, unknown>> };

  it('(a) round-trips subscription parent, API key slots and defaultMethod', async () => {
    await h.credentials.saveSubscription('ws-1', 'openai', subCredential(), 'u-owner');
    await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'openai',
      apiKey: fakeKey('openai-slot'),
      userId: 'u-owner',
    });
    await h.credentials.setProviderDefaultMethod('ws-1', 'openai', 'api-key');

    const file = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const openai = file.credentials.find((c: { provider: string }) => c.provider === 'openai');
    expect(openai?.key).toBeDefined();
    expect(openai?.keys).toHaveLength(1);
    expect(openai?.defaultMethod).toBe('api-key');

    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);

    const restored = (await keys('ws-2')).keys.find((row) => row.provider === 'openai');
    expect(restored).toMatchObject({
      hasSubscription: true,
      defaultMethod: 'api-key',
      keys: [{ last4: fakeKey('openai-slot').slice(-4) }],
    });
    expect(await h.store.getProviderAuthPreference('ws-2', 'openai')).toBe('api-key');
    const roster = await h.credentials.resolveKeyRoster('ws-2', 'openai');
    expect(roster?.secrets[0]?.reveal()).toBe(fakeKey('openai-slot'));
    expect((await h.credentials.resolve('ws-2', 'openai')).reveal()).toContain('mergepilot:oauth');
  });

  it('(b) keeps existing key slots when the file has a subscription parent but no key list', async () => {
    await h.credentials.saveSubscription('ws-1', 'anthropic', subCredential(), 'u-owner');
    await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'anthropic',
      apiKey: fakeKey('anthropic-keep'),
      userId: 'u-owner',
    });
    const slotBefore = (await h.store.listProviderKeys('ws-1', 'anthropic'))[0]!;
    expect(slotBefore.last4).toBe(fakeKey('anthropic-keep').slice(-4));

    const full = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const anthropic = full.credentials.find((c: { provider: string }) => c.provider === 'anthropic') as {
      provider: string;
      key: unknown;
      last4: string;
      defaultMethod?: string;
    };
    const file = {
      ...full,
      credentials: [{ provider: 'anthropic', last4: anthropic.last4, key: anthropic.key, defaultMethod: 'subscription' }],
    };

    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE }, 'owner', 'ws-1');
    expect(res.statusCode).toBe(200);
    const slotsAfter = await h.store.listProviderKeys('ws-1', 'anthropic');
    expect(slotsAfter).toHaveLength(1);
    expect(slotsAfter[0]?.last4).toBe(fakeKey('anthropic-keep').slice(-4));
    expect((await h.credentials.resolve('ws-1', 'anthropic')).reveal()).toContain('mergepilot:oauth');
  });

  it('(c) keys-only restore replaces slots but keeps a connected subscription parent', async () => {
    await h.credentials.saveSubscription('ws-1', 'xai', subCredential(), 'u-owner');
    await h.credentials.appendProviderKey({
      workspaceId: 'ws-1',
      provider: 'xai',
      apiKey: fakeKey('xai-old'),
      userId: 'u-owner',
    });
    expect((await h.credentials.resolveKeyRoster('ws-1', 'xai'))?.secrets[0]?.reveal()).toBe(fakeKey('xai-old'));

    const newKey = fakeKey('xai-new');
    const sealedOnly = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const { deriveBackupKey, newBackupSalt, sealBackupKey } = await import('../backup/passphrase-crypto.js');
    const salt = newBackupSalt();
    const fileKey = await deriveBackupKey(PASSPHRASE, salt);
    const sealedNew = sealBackupKey(newKey, fileKey, salt, { provider: 'xai', baseUrl: null });
    const file = {
      ...sealedOnly,
      credentials: [{ provider: 'xai', last4: newKey.slice(-4), keys: [sealedNew] }],
    };

    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE }, 'owner', 'ws-1');
    expect(res.statusCode).toBe(200);
    expect((await h.credentials.resolve('ws-1', 'xai')).reveal()).toContain('mergepilot:oauth');
    expect((await h.credentials.resolveKeyRoster('ws-1', 'xai'))?.secrets[0]?.reveal()).toBe(newKey);
  });

  it('(d) keys-only restore without a subscription mirrors slot 0 as the parent', async () => {
    const apiKey = fakeKey('openai-only');
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openai', apiKey, userId: 'u-owner' });
    const file = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const entry = file.credentials.find((c: { provider: string }) => c.provider === 'openai');
    const keysOnly = { ...file, credentials: [{ provider: 'openai', last4: entry?.last4, keys: entry?.keys }] };

    await h.credentials.deleteKey('ws-1', 'openai');
    const res = await restoreBackup(h, { file: keysOnly, passphrase: PASSPHRASE }, 'owner', 'ws-1');
    expect(res.statusCode).toBe(200);
    expect((await h.credentials.resolve('ws-1', 'openai')).reveal()).toBe(apiKey);
    expect(await h.store.listProviderKeys('ws-1', 'openai')).toHaveLength(1);
  });

  it('(e) rejects a subscription envelope placed in the sealed key list', async () => {
    const { deriveBackupKey, newBackupSalt, sealBackupKey } = await import('../backup/passphrase-crypto.js');
    const salt = newBackupSalt();
    const fileKey = await deriveBackupKey(PASSPHRASE, salt);
    const envelope = encodeSubscription('openai', subCredential());
    const sealed = sealBackupKey(envelope, fileKey, salt, { provider: 'openai', baseUrl: null });
    const file = {
      format: 'mergepilot-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      app: { version: '0.2' },
      workspace: { name: 'dual' },
      settings: null,
      bots: [],
      credentials: [{ provider: 'openai', last4: '1111', keys: [sealed] }],
    };
    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'subscription_in_key_list' } });
  });

  it('(f) leaves non-dual providers on the legacy restore path unchanged', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'typesafe', apiKey: fakeKey('typesafe'), userId: 'u-owner' });
    const file = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
    const res = await restoreBackup(h, { file, passphrase: PASSPHRASE });
    expect(res.statusCode).toBe(200);
    expect((await h.credentials.resolve('ws-2', 'typesafe')).reveal()).toBe(fakeKey('typesafe'));
    expect(await h.store.listProviderKeys('ws-2', 'typesafe')).toHaveLength(0);
  });
});

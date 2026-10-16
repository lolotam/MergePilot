import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionLogins } from './subscription-login.js';
import { MemoryStore } from '../core/memory-store.js';
import { CredentialService } from './service.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';

afterEach(() => vi.useRealTimers());
describe('subscription attempt lifecycle', () => {
  it('reports an already-committed completion honestly when a cancellation arrives too late', async () => {
    const logins = new SubscriptionLogins(async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 }));
    const state = logins.start('ws', 'user', 'xai');
    await Promise.resolve();
    const attempt = logins.get('ws', 'user', state.id)!;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    // Simulate storage that already committed but has not yet returned its result.
    const finishing = logins.finish(attempt, async () => { await done; });
    const cancelling = logins.cancelAndWait(attempt);
    release();
    await finishing;
    expect(await cancelling).toBe(false);
    expect(logins.snapshot(attempt).status).toBe('completed');
    logins.close();
  });
  it('honors cancellation while completion is waiting for the credential lock', async () => {
    const store = new MemoryStore();
    const service = new CredentialService({ store, vault: new EnvelopeVault(Buffer.alloc(32, 8).toString('base64')) });
    await service.saveKey({ workspaceId: 'ws', provider: 'xai', apiKey: ['previous', 'api', 'key'].join('-'), userId: 'user' });
    const modifyKeys = vi.spyOn(store, 'modifyProviderKeys');
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const holding = store.modifyCredential('ws', 'xai', async (current) => { acquired(); await held; return current; });
    await locked;
    const logins = new SubscriptionLogins(async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 }));
    const state = logins.start('ws', 'user', 'xai');
    await Promise.resolve();
    const attempt = logins.get('ws', 'user', state.id)!;
    const finishing = logins.finish(attempt, (provider, credential, signal) => service.saveSubscription('ws', provider, credential, 'user', signal));
    await vi.waitFor(() => expect(modifyKeys).toHaveBeenCalledTimes(1));
    logins.cancel(attempt);
    release();
    await holding;
    await expect(finishing).rejects.toThrow();
    expect((await service.resolve('ws', 'xai')).reveal()).toBe('previous-api-key');
    expect(logins.snapshot(attempt).status).toBe('cancelled');
    logins.close();
  });
  it('isolates attempts by both initiating user and workspace', () => {
    const logins = new SubscriptionLogins(async (_provider, interaction) => {
      await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 };
    });
    const state = logins.start('ws', 'user-a', 'anthropic');
    expect(logins.get('ws', 'user-b', state.id)).toBeUndefined();
    expect(logins.get('ws-other', 'user-a', state.id)).toBeUndefined();
    expect(logins.get('ws', 'user-a', state.id)).toBeDefined();
    logins.close();
  });

  it('expires and aborts a waiting login without retaining its prompt', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const logins = new SubscriptionLogins(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: 'manual_code', message: 'Code' });
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 };
    }, 1000);
    const state = logins.start('ws', 'user', 'anthropic');
    await vi.advanceTimersByTimeAsync(1001);
    expect(signal?.aborted).toBe(true);
    expect(logins.get('ws', 'user', state.id)).toBeUndefined();
    logins.close();
  });

  it('cancels a previous login for the same provider and waits for only one concurrent save', async () => {
    const logins = new SubscriptionLogins(async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3600000 }));
    const first = logins.start('ws', 'user', 'xai');
    const second = logins.start('ws', 'user', 'xai');
    await Promise.resolve();
    expect(logins.get('ws', 'user', first.id)?.state.status).toBe('cancelled');
    const attempt = logins.get('ws', 'user', second.id)!;
    const save = vi.fn(async () => { await Promise.resolve(); });
    await Promise.all([logins.finish(attempt, save), logins.finish(attempt, save)]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(logins.snapshot(attempt).status).toBe('completed');
    expect(JSON.stringify(logins.snapshot(attempt))).not.toContain('refresh');
    logins.close();
  });
});

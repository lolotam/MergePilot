import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionLogins } from './subscription-login.js';

afterEach(() => vi.useRealTimers());
describe('subscription attempt lifecycle', () => {
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

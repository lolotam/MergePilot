import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupHarness, type BackupHarness, type Who } from './backup-routes.fixtures.js';

/** The fields every settings PUT carries (the patch semantics keep the rest). */
const REQUIRED = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en' } as const;

/** An extra bot whose provider needs no stored key (the worker skips a keyless primary). */
const owl = { name: 'Owl', logo: 'owl', provider: 'anthropic', model: 'claude-haiku-5', fallback: [] };

describe('per-bot call timeout through the API (migration 0018)', { timeout: 90000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
  }, 90000);

  afterEach(async () => {
    await h.close();
  });

  const putSettings = (payload: Record<string, unknown>, who: Who | null = 'owner', ws = 'ws-1') =>
    h.app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws}/settings`,
      headers: who ? { cookie: h.cookie(who) } : {},
      payload: { ...REQUIRED, ...payload },
    });
  const getSettings = async (who: Who | null = 'owner', ws = 'ws-1') =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/settings`, headers: who ? { cookie: h.cookie(who) } : {} })).json()
      .settings;
  const putBot = (slot: number | string, payload: Record<string, unknown>, who: Who | null = 'owner', ws = 'ws-1') =>
    h.app.inject({
      method: 'PUT',
      url: `/api/workspaces/${ws}/bots/${slot}`,
      headers: who ? { cookie: h.cookie(who) } : {},
      payload,
    });
  const getBots = async (who: Who = 'member', ws = 'ws-1') =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/bots`, headers: { cookie: h.cookie(who) } })).json();

  it('lets the owner and an admin save the main timeout; a member and a signed-out request are refused', async () => {
    expect((await putSettings({ callTimeoutMs: 600000 }, 'member')).statusCode).toBe(403);
    expect((await putSettings({ callTimeoutMs: 600000 }, null)).statusCode).toBe(401);

    const saved = await putSettings({ callTimeoutMs: 600000 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.callTimeoutMs).toBe(600000);

    // Members read both the settings and the main bot's timeout.
    expect((await getSettings('member')).callTimeoutMs).toBe(600000);
    expect((await getBots('member')).main.callTimeoutMs).toBe(600000);

    const admin = await putSettings({ callTimeoutMs: 900000 }, 'admin');
    expect(admin.statusCode).toBe(200);
    expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBe(900000);
  });

  it('keeps the stored timeout when an update omits it, and resets it to inheritance on null', async () => {
    expect((await putSettings({ callTimeoutMs: 600000 })).statusCode).toBe(200);

    const otherField = await putSettings({ monthlyBudgetUsd: 40 });
    expect(otherField.statusCode).toBe(200);
    expect(otherField.json().settings.callTimeoutMs).toBe(600000);
    expect((await getBots()).main.callTimeoutMs).toBe(600000);

    const reset = await putSettings({ callTimeoutMs: null });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().settings.callTimeoutMs).toBeNull();
    expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBeNull();
    expect((await getBots()).main.callTimeoutMs).toBeNull();
  });

  it('accepts 1000 and 1200000 and rejects below, above, fractional and string values without writing', async () => {
    expect((await putSettings({ callTimeoutMs: 1000 })).statusCode).toBe(200);
    expect((await putSettings({ callTimeoutMs: 1200000 })).statusCode).toBe(200);

    for (const value of [999, 1200001, 0, -1, 1.5, '600000']) {
      const res = await putSettings({ callTimeoutMs: value });
      expect([value, res.statusCode, res.json().error?.code]).toEqual([value, 400, 'validation_error']);
      expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBe(1200000);
    }
  });

  it('forwards an extra bot timeout including null, keeping it when the field is omitted', async () => {
    const created = await putBot(2, { ...owl, callTimeoutMs: 600000 });
    expect(created.statusCode).toBe(200);
    expect(created.json().bot.callTimeoutMs).toBe(600000);

    // A form that does not send the timeout leaves the stored override alone.
    const kept = await putBot(2, { ...owl, effort: 'low' });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().bot.callTimeoutMs).toBe(600000);
    expect((await getBots()).bots.find((bot: { slot: number }) => bot.slot === 2).callTimeoutMs).toBe(600000);

    const reset = await putBot(2, { ...owl, callTimeoutMs: null });
    expect(reset.json().bot.callTimeoutMs).toBeNull();
    expect((await h.store.listReviewerBots('ws-1'))[0]?.callTimeoutMs).toBeNull();

    expect((await putBot(2, { ...owl, callTimeoutMs: 1.5 })).statusCode).toBe(400);
    expect((await putBot(2, owl, 'member')).statusCode).toBe(403);
    expect((await putBot(2, owl, null)).statusCode).toBe(401);
    const byAdmin = await putBot(2, { ...owl, callTimeoutMs: 300000 }, 'admin');
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().bot.callTimeoutMs).toBe(300000);
  });

  it('rejects a stale main settings base without changing the stored timeout', async () => {
    expect((await putSettings({ monthlyBudgetUsd: 50 })).statusCode).toBe(200);
    const base = await h.store.getSettings('ws-1');
    expect((await putSettings({ callTimeoutMs: 600000 })).statusCode).toBe(200);

    const res = await putSettings({ callTimeoutMs: 900000, base });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('settings_conflict');
    expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBe(600000);
  });

  it('does not overwrite a concurrent timeout update with an unrelated edit', async () => {
    expect((await putSettings({ monthlyBudgetUsd: 50 })).statusCode).toBe(200);
    const base = await h.store.getSettings('ws-1');
    expect((await putSettings({ callTimeoutMs: 600000 })).statusCode).toBe(200);

    // A dashboard form that read the base before the timeout change and edits the budget only.
    const res = await putSettings({ monthlyBudgetUsd: 75, base });
    expect(res.statusCode).toBe(200);
    expect(await h.store.getSettings('ws-1')).toMatchObject({ monthlyBudgetUsd: 75, callTimeoutMs: 600000 });

    // An older client without a base keeps it too.
    expect((await putSettings({ maxFindings: 20 })).statusCode).toBe(200);
    expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBe(600000);
  });

  it('keeps each workspace to its own timeout and refuses a non-member', async () => {
    expect((await putSettings({ callTimeoutMs: 600000 }, 'owner', 'ws-1')).statusCode).toBe(200);
    // The same person owns ws-2; ws-3 belongs to the admin.
    expect((await putSettings({ callTimeoutMs: 900000 }, 'owner', 'ws-2')).statusCode).toBe(200);
    expect((await putSettings({ callTimeoutMs: 1000 }, 'owner', 'ws-3')).statusCode).toBe(403);
    expect((await putSettings({ callTimeoutMs: 1000 }, 'admin', 'ws-3')).statusCode).toBe(200);

    expect((await h.store.getSettings('ws-1'))?.callTimeoutMs).toBe(600000);
    expect((await h.store.getSettings('ws-2'))?.callTimeoutMs).toBe(900000);
    expect((await h.store.getSettings('ws-3'))?.callTimeoutMs).toBe(1000);
  });
});

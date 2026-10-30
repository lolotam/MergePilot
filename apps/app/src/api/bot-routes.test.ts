import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOT_LOGOS } from '../core/types.js';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

const owl = {
  name: 'Owl',
  logo: 'owl',
  active: true,
  provider: 'openrouter',
  model: 'openai/gpt-5',
  effort: 'high',
  fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: null }],
};

describe('reviewer panel bots API (ADR-0017)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const get = (cookie = h.memberCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/bots`, headers: { cookie } });
  const put = (slot: number | string, payload: Record<string, unknown>, cookie = h.adminCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/bots/${slot}`, headers: { cookie }, payload });
  const del = (slot: number | string, cookie = h.adminCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'DELETE', url: `/api/workspaces/${ws}/bots/${slot}`, headers: { cookie } });
  const errorOf = async (slot: number | string, payload: Record<string, unknown>) => {
    const res = await put(slot, payload);
    return [res.statusCode, res.json().error?.code];
  };
  const settings = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en' };
  const putSettings = (payload: Record<string, unknown>, cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie }, payload: { ...settings, ...payload } });

  it('lists the main bot, the panel defaults and the logo keys before anything is configured', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      main: { slot: 1, name: 'MergePilot', logo: 'pilot', active: true, provider: null, model: null, effort: null, fallback: [], exploreEnabled: false, callTimeoutMs: null },
      bots: [],
      panel: { mode: 'separate', minAgreement: 1 },
      logos: [...BOT_LOGOS],
    });
  });

  it('creates, replaces, lists by slot and deletes extra bots; members only read', async () => {
    expect((await putSettings({ effort: 'high', fallback: [{ provider: 'anthropic', model: 'claude-opus-5' }] })).statusCode).toBe(200);
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });

    const fox = { name: '  Fox  ', logo: 'fox', provider: 'anthropic', model: 'claude-haiku-5' };
    const saved = await put(4, fox);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().bot).toEqual({ slot: 4, name: 'Fox', logo: 'fox', active: true, provider: 'anthropic', model: 'claude-haiku-5', effort: null, fallback: [], exploreEnabled: false, callTimeoutMs: null });
    expect((await put(2, { ...owl, exploreEnabled: true })).statusCode).toBe(200);
    expect((await put(2, { ...owl, active: false, fallback: [] })).json().bot).toMatchObject({ slot: 2, active: false, fallback: [], exploreEnabled: true });

    const listed = (await get()).json();
    expect(listed.main).toEqual({
      slot: 1, name: 'MergePilot', logo: 'pilot', active: true, provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'high',
      fallback: [{ provider: 'anthropic', model: 'claude-opus-5' }], exploreEnabled: false, callTimeoutMs: null,
    });
    expect(listed.bots.map((b: { slot: number; name: string; active: boolean }) => [b.slot, b.name, b.active])).toEqual([
      [2, 'Owl', false],
      [4, 'Fox', true],
    ]);

    expect((await put(3, owl, h.memberCookie())).statusCode).toBe(403);
    expect((await del(2, h.memberCookie())).statusCode).toBe(403);
    expect((await del(4)).statusCode).toBe(204);
    expect((await del(4)).statusCode).toBe(404);
    expect((await get()).json().bots.map((b: { slot: number }) => b.slot)).toEqual([2]);
  });

  it('defaults exploration off on creation and keeps it enabled when omitted later', async () => {
    const bot = { ...owl, provider: 'anthropic', model: 'claude-haiku-5', fallback: [] };
    const created = await put(2, bot);
    expect(created.statusCode).toBe(200);
    expect(created.json().bot.exploreEnabled).toBe(false);

    expect((await put(2, { ...bot, exploreEnabled: true })).statusCode).toBe(200);
    const updated = await put(2, bot);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().bot.exploreEnabled).toBe(true);
  });

  it('validates the name, logo and slot', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });
    expect(await errorOf(2, { ...owl, name: '   ' })).toEqual([400, 'validation_error']);
    expect(await errorOf(2, { ...owl, name: 'x'.repeat(41) })).toEqual([400, 'validation_error']);
    expect((await put(2, { ...owl, name: 'x'.repeat(40) })).statusCode).toBe(200);
    expect(await errorOf(3, { ...owl, name: 'X'.repeat(40) })).toEqual([409, 'bot_name_taken']);
    expect(await errorOf(3, { ...owl, name: 'mergepilot' })).toEqual([409, 'bot_name_taken']);
    expect(await errorOf(3, { ...owl, logo: 'unicorn' })).toEqual([400, 'validation_error']);
    for (const slot of [1, 6, 0, 'two', '2.5']) {
      expect(await errorOf(slot, { ...owl, name: 'Slot test' })).toEqual([400, 'invalid_slot']);
    }
    expect((await del(1)).json().error.code).toBe('invalid_slot');
  });

  it('checks the provider, model, effort and fallback like the main settings', async () => {
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'openrouter', apiKey: keyFor('or'), userId: 'u-admin' });
    expect(await errorOf(2, { ...owl, provider: 'nope' })).toEqual([400, 'validation_error']);
    expect(await errorOf(2, { ...owl, model: '  ' })).toEqual([400, 'validation_error']);
    expect(await errorOf(2, { ...owl, effort: 'HIGH; drop' })).toEqual([400, 'validation_error']);
    const fb = (model: string, provider = 'anthropic') => ({ provider, model });
    expect(await errorOf(2, { ...owl, fallback: [fb('a'), fb('b'), fb('c'), fb('d')] })).toEqual([400, 'validation_error']);
    expect(await errorOf(2, { ...owl, fallback: [fb('openai/gpt-5', 'openrouter')] })).toEqual([400, 'fallback_duplicate']);
    expect(await errorOf(2, { ...owl, fallback: [fb('a'), fb('a')] })).toEqual([400, 'fallback_duplicate']);
    expect(await errorOf(2, { ...owl, fallback: [fb('gemini-3.8-flash', 'gemini')] })).toEqual([400, 'fallback_key_missing']);
    // The bot's own provider needs no stored key yet: the worker skips it ("no key").
    expect((await put(2, { ...owl, provider: 'openai', model: 'gpt-5', fallback: [] })).statusCode).toBe(200);
  });

  it('keeps each workspace to its own bots', async () => {
    await h.addWorkspace('ws-2');
    expect((await put(3, { ...owl, fallback: [] })).statusCode).toBe(200);
    expect((await del(3, h.adminCookie(), 'ws-2')).statusCode).toBe(404);
    expect((await get(h.adminCookie(), 'ws-2')).json().bots).toEqual([]);
    expect((await put(3, { ...owl, fallback: [] }, h.adminCookie(), 'ws-2')).statusCode).toBe(200);
    expect((await get(h.memberCookie(), 'ws-2')).statusCode).toBe(403);
    expect((await get()).json().bots).toHaveLength(1);
  });

  it('returns each run\'s bot in the runs list, the PR groups and the run detail', async () => {
    const base = { workspaceId: 'ws-1', installationId: 1, repoFullName: 'acme/api', pullNumber: 7, headSha: 'sha', status: 'queued' as const, costUsd: null, detail: null };
    const main = await h.store.createReviewRun(base);
    await h.store.createReviewRun({ ...base, botSlot: 3, botName: 'Fox' });
    const list = async (query: string) =>
      (await h.app.inject({ method: 'GET', url: `/api/workspaces/ws-1/runs${query}`, headers: { cookie: h.memberCookie() } })).json();
    const bots = (runs: Array<{ botSlot: number; botName: string | null }>) => runs.map((r) => [r.botSlot, r.botName]).sort();
    expect(bots((await list('?limit=10')).runs)).toEqual([[1, null], [3, 'Fox']]);
    expect(bots((await list('?groupBy=pr')).groups[0].runs)).toEqual([[1, null], [3, 'Fox']]);
    expect((await list(`/${main.id}`)).run).toMatchObject({ botSlot: 1, botName: null });
  });

  it('settings PUT saves the main bot name and logo and the panel mode, keeping them when left out', async () => {
    const panel = { botName: ' Pilot One ', botLogo: 'rocket', panelMode: 'consensus', panelMinAgreement: 2, exploreEnabled: true };
    expect((await putSettings(panel, h.memberCookie())).statusCode).toBe(403);
    const res = await putSettings(panel);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ ...panel, botName: 'Pilot One' });
    expect((await putSettings({ minSeverity: 'high' })).json().settings).toMatchObject({ ...panel, botName: 'Pilot One' });
    expect((await get()).json()).toMatchObject({
      main: { name: 'Pilot One', logo: 'rocket' },
      panel: { mode: 'consensus', minAgreement: 2 },
    });

    const code = async (payload: Record<string, unknown>) => {
      const r = await putSettings(payload);
      return [r.statusCode, r.json().error?.code];
    };
    expect(await code({ botName: '' })).toEqual([400, 'validation_error']);
    expect(await code({ botName: 'x'.repeat(41) })).toEqual([400, 'validation_error']);
    expect(await code({ botLogo: 'unicorn' })).toEqual([400, 'validation_error']);
    expect(await code({ panelMode: 'vote' })).toEqual([400, 'validation_error']);
    expect(await code({ panelMinAgreement: 0 })).toEqual([400, 'validation_error']);
    expect(await code({ panelMinAgreement: 6 })).toEqual([400, 'validation_error']);
    expect(await code({ panelMinAgreement: 1.5 })).toEqual([400, 'validation_error']);

    // The main bot's name must differ from every extra bot's, ignoring case.
    expect((await put(2, { ...owl, fallback: [], provider: 'anthropic' })).statusCode).toBe(200);
    expect(await code({ botName: 'OWL' })).toEqual([409, 'bot_name_taken']);
    expect((await putSettings({ botName: 'pilot one' })).statusCode).toBe(200);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, listModels: vi.fn(actual.listModels), testConnection: vi.fn(actual.testConnection) };
});

const { listModels, testConnection } = await import('@mergepilot/engine');

describe('provider key list routes', { timeout: 60000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(listModels).mockRejectedValue(new Error('offline in tests'));
    h = await createProviderHarness();
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const cookie = () => ({ cookie: h.adminCookie() });

  it('lists metadata only, keeps order across reorder and delete, and hides the list from another workspace', async () => {
    const first = keyFor('a');
    const second = keyFor('b');
    const third = keyFor('c');
    const created = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/gemini',
      headers: cookie(),
      payload: { apiKeys: [first, second, third] },
    });
    expect(created.statusCode).toBe(200);
    const saved = created.json() as { keys: Array<{ id: string; position: number; last4: string }> };
    expect(saved.keys.map((slot) => slot.position)).toEqual([0, 1, 2]);
    expect(saved.keys.map((slot) => slot.last4)).toEqual([first, second, third].map((key) => key.slice(-4)));
    expect(created.body).not.toContain(first);
    expect(created.body).not.toContain(second);
    const stored = await h.store.listProviderKeys('ws-1', 'gemini');
    expect(stored[0]?.ciphertext).not.toContain(first);

    const reversed = [...saved.keys].map((slot) => slot.id).reverse();
    const ordered = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/gemini/order',
      headers: cookie(),
      payload: { ids: reversed },
    });
    expect(ordered.statusCode).toBe(200);
    const orderBody = ordered.json() as { keys: Array<{ id: string; position: number }> };
    expect(orderBody.keys.map((slot) => slot.id)).toEqual(reversed);
    expect(orderBody.keys.map((slot) => slot.position)).toEqual([0, 1, 2]);

    const removed = orderBody.keys[1]?.id;
    const deleted = await h.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/ws-1/keys/gemini/slots/${removed}`,
      headers: cookie(),
    });
    expect(deleted.statusCode).toBe(204);
    const listed = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/keys', headers: cookie() });
    const gemini = (listed.json() as { keys: Array<{ provider: string; keys?: Array<{ id: string; position: number }> }> }).keys.find(
      (row) => row.provider === 'gemini',
    );
    expect(gemini?.keys?.map((slot) => slot.position)).toEqual([0, 1]);
    expect(gemini?.keys?.map((slot) => slot.id)).toEqual([reversed[0], reversed[2]]);
    expect(listed.body).not.toContain(first);

    await h.addWorkspace('ws-2');
    const other = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-2/keys', headers: cookie() });
    expect(other.statusCode).toBe(200);
    expect((other.json() as { keys: unknown[] }).keys).toEqual([]);
    const planted = keyFor('other');
    await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-2/keys/gemini',
      headers: cookie(),
      payload: { apiKeys: [planted] },
    });
    const still = await h.store.listProviderKeys('ws-1', 'gemini');
    expect(still.map((slot) => slot.id)).toEqual([reversed[0], reversed[2]]);
    expect(JSON.stringify(still)).not.toContain(planted);
  });

  it('refuses a 21st key and leaves the list empty', async () => {
    const many = Array.from({ length: 21 }, (_, index) => keyFor(`n${index}`));
    const refused = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/gemini',
      headers: cookie(),
      payload: { apiKeys: many },
    });
    expect([refused.statusCode, refused.json().error.code]).toEqual([400, 'too_many_keys']);
    expect(await h.store.listProviderKeys('ws-1', 'gemini')).toEqual([]);
    const twenty = many.slice(0, 20);
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/openrouter',
      headers: cookie(),
      payload: { apiKeys: twenty },
    });
    expect(saved.statusCode).toBe(200);
    const extra = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/keys/openrouter/slots',
      headers: cookie(),
      payload: { apiKey: keyFor('extra') },
    });
    expect([extra.statusCode, extra.json().error.code]).toEqual([400, 'too_many_keys']);
    expect(await h.store.listProviderKeys('ws-1', 'openrouter')).toHaveLength(20);
  });

  it('refuses a member and an unsigned caller', async () => {
    const member = await h.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/keys',
      headers: { cookie: h.memberCookie() },
    });
    expect(member.statusCode).toBe(403);
    const write = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/gemini',
      headers: { cookie: h.memberCookie() },
      payload: { apiKeys: [keyFor('mem')] },
    });
    expect(write.statusCode).toBe(403);
    const unsigned = await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/keys' });
    expect(unsigned.statusCode).toBe(401);
    expect(await h.store.listProviderKeys('ws-1', 'gemini')).toEqual([]);
  });

  it('does not leak unexpected append errors as validation_failed', async () => {
    vi.spyOn(h.credentials, 'appendProviderKey').mockRejectedValueOnce(new Error('database exploded'));
    const apiKey = keyFor('boom');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/keys/gemini/slots',
      headers: cookie(),
      payload: { apiKey },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(res.body).not.toContain('database exploded');
  });

  it('tests an unsaved key without storing it, and records a stored key by id', async () => {
    const unsaved = keyFor('unsaved');
    vi.mocked(testConnection).mockResolvedValue({ ok: true, ms: 4, model: 'gemini-2.0-flash', reply: 'OK' });
    const tested = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { apiKey: unsaved, model: 'gemini-2.0-flash' },
    });
    expect(tested.json()).toMatchObject({ ok: true, quotaStatus: 'valid' });
    expect(tested.body).not.toContain(unsaved);
    expect(await h.credentials.getCredential('ws-1', 'gemini')).toBeNull();
    expect(await h.store.listProviderKeys('ws-1', 'gemini')).toEqual([]);

    const both = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { apiKey: unsaved, keyId: '11111111-1111-4111-8111-111111111111', model: 'gemini-2.0-flash' },
    });
    expect([both.statusCode, both.json().error.code]).toEqual([400, 'validation_error']);

    const kept = keyFor('kept');
    const created = await h.app.inject({
      method: 'PUT',
      url: '/api/workspaces/ws-1/keys/gemini',
      headers: cookie(),
      payload: { apiKeys: [kept, keyFor('next')] },
    });
    const keyId = (created.json() as { keys: Array<{ id: string }> }).keys[0]?.id;
    vi.mocked(testConnection).mockResolvedValue({ ok: false, ms: 3, code: 'quota', message: `over ${kept}` });
    const stored = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { keyId, model: 'gemini-2.0-flash' },
    });
    expect(stored.json()).toMatchObject({ ok: false, quotaStatus: 'quota-exhausted' });
    expect(stored.body).not.toContain(kept);
    const slots = await h.store.listProviderKeys('ws-1', 'gemini');
    expect(slots.find((slot) => slot.id === keyId)?.lastTestStatus).toBe('quota-exhausted');
    expect(slots.find((slot) => slot.id !== keyId)?.lastTestStatus).toBeNull();

    // A transient failure (rate limit, outage, network) is not proof of a bad key: the status stays.
    vi.mocked(testConnection).mockResolvedValue({ ok: false, ms: 3, code: 'rate-limit', message: 'slow down' });
    const limited = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { keyId, model: 'gemini-2.0-flash' },
    });
    expect(limited.json()).toMatchObject({ ok: false, code: 'rate-limit' });
    expect(limited.json()).not.toHaveProperty('quotaStatus');
    vi.mocked(testConnection).mockRejectedValue(new Error('socket hang up'));
    const offline = await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { keyId, model: 'gemini-2.0-flash' },
    });
    expect(offline.json()).toMatchObject({ ok: false, code: 'network' });
    expect(offline.json()).not.toHaveProperty('quotaStatus');
    const after = await h.store.listProviderKeys('ws-1', 'gemini');
    expect(after.find((slot) => slot.id === keyId)?.lastTestStatus).toBe('quota-exhausted');

    vi.mocked(testConnection).mockResolvedValue({ ok: false, ms: 3, code: 'auth', message: 'bad key' });
    await h.app.inject({
      method: 'POST',
      url: '/api/workspaces/ws-1/credentials/gemini/test',
      headers: cookie(),
      payload: { keyId, model: 'gemini-2.0-flash' },
    });
    const rejected = await h.store.listProviderKeys('ws-1', 'gemini');
    expect(rejected.find((slot) => slot.id === keyId)?.lastTestStatus).toBe('invalid');
  });
});

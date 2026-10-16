import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FINDINGS_CHOICES, SettingsUpdateSchema } from './contract.js';
import { createProviderHarness, type ProviderHarness } from './provider-routes.fixtures.js';

// The workspace's findings limit per published review (ADR-0033).

describe('settings contract: maxFindings', () => {
  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };

  it('accepts exactly the ten dashboard choices', () => {
    expect([...MAX_FINDINGS_CHOICES]).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    for (const maxFindings of MAX_FINDINGS_CHOICES) {
      expect(SettingsUpdateSchema.parse({ ...base, maxFindings }).maxFindings).toBe(maxFindings);
    }
  });

  it.each([1, 4, 7, 51, 55, 100, 2.5, '10', null])('rejects %s', (maxFindings) => {
    expect(SettingsUpdateSchema.safeParse({ ...base, maxFindings }).success).toBe(false);
  });

  it('leaves the field out when the body does not name it', () => {
    expect(SettingsUpdateSchema.parse(base)).not.toHaveProperty('maxFindings');
  });
});

describe('PUT /settings maxFindings', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const base = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'ar' };
  const put = (payload: Record<string, unknown>, ws = 'ws-1', cookie = h.adminCookie()) =>
    h.app.inject({ method: 'PUT', url: `/api/workspaces/${ws}/settings`, headers: { cookie }, payload: { ...base, ...payload } });
  const read = async (ws = 'ws-1', cookie = h.adminCookie()) =>
    (await h.app.inject({ method: 'GET', url: `/api/workspaces/${ws}/settings`, headers: { cookie } })).json().settings;

  it('reads back 5 until an admin picks another choice, which members can read but not write', async () => {
    expect((await put({})).statusCode).toBe(200);
    expect((await read()).maxFindings).toBe(5);

    const member = await put({ maxFindings: 30 }, 'ws-1', h.memberCookie());
    expect(member.statusCode).toBe(403);
    expect((await read()).maxFindings).toBe(5);

    expect((await put({ maxFindings: 30 })).statusCode).toBe(200);
    expect((await read('ws-1', h.memberCookie())).maxFindings).toBe(30);
  });

  it('refuses a value outside the choices with validation_error and keeps the stored one', async () => {
    expect((await put({ maxFindings: 20 })).statusCode).toBe(200);
    for (const maxFindings of [1, 7, 51]) {
      const res = await put({ maxFindings });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
    expect((await read()).maxFindings).toBe(20);
  });

  it('a PUT that leaves it out keeps the stored value', async () => {
    expect((await put({ maxFindings: 45 })).statusCode).toBe(200);
    expect((await put({ minSeverity: 'high' })).statusCode).toBe(200);
    expect(await read()).toMatchObject({ maxFindings: 45, minSeverity: 'high' });
  });

  it('is kept per workspace', async () => {
    await h.addWorkspace('ws-2');
    expect((await put({ maxFindings: 40 })).statusCode).toBe(200);
    expect((await put({}, 'ws-2')).statusCode).toBe(200);
    expect((await read('ws-2')).maxFindings).toBe(5);

    expect((await put({ maxFindings: 10 }, 'ws-2')).statusCode).toBe(200);
    expect((await read('ws-1')).maxFindings).toBe(40);
    // The ws-1 member is no member of ws-2.
    expect((await put({ maxFindings: 50 }, 'ws-2', h.memberCookie())).statusCode).toBe(403);
    expect((await read('ws-2')).maxFindings).toBe(10);
  });
});

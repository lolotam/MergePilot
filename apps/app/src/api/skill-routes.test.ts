import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderHarness, keyFor, type ProviderHarness } from './provider-routes.fixtures.js';

// Review skills API (ADR-0034): admin-only writes, workspace isolation, content checks, and a
// deleted skill falling back to Default with a visible note.

// Built at runtime so no scanner mistakes the fixture for a real key.
const FAKE_AWS_KEY = ['AKIA', 'Q'.repeat(16)].join('');

describe('review skills API (ADR-0034)', { timeout: 25000 }, () => {
  let h: ProviderHarness;

  beforeEach(async () => {
    h = await createProviderHarness();
    await h.credentials.saveKey({ workspaceId: 'ws-1', provider: 'anthropic', apiKey: keyFor('a'), userId: 'u-admin' });
  }, 30000);

  afterEach(async () => {
    await h.close();
  });

  const url = (ws: string, id?: string) => `/api/workspaces/${ws}/skills${id ? `/${id}` : ''}`;
  const create = (payload: Record<string, unknown>, cookie = h.adminCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'POST', url: url(ws), headers: { cookie }, payload });
  const update = (id: string, payload: Record<string, unknown>, cookie = h.adminCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'PUT', url: url(ws, id), headers: { cookie }, payload });
  const remove = (id: string, cookie = h.adminCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'DELETE', url: url(ws, id), headers: { cookie } });
  const read = (id: string, cookie = h.memberCookie(), ws = 'ws-1') =>
    h.app.inject({ method: 'GET', url: url(ws, id), headers: { cookie } });
  const list = (cookie = h.memberCookie()) => h.app.inject({ method: 'GET', url: url('ws-1'), headers: { cookie } });
  const settings = { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en' };
  const putSettings = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/settings', headers: { cookie: h.adminCookie() }, payload: { ...settings, ...payload } });
  const owl = { name: 'Owl', logo: 'owl', provider: 'anthropic', model: 'claude-haiku-5' };
  const putBot = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'PUT', url: '/api/workspaces/ws-1/bots/2', headers: { cookie: h.adminCookie() }, payload: { ...owl, ...payload } });
  const bots = async () => (await h.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/bots', headers: { cookie: h.memberCookie() } })).json();
  const codeOf = async (res: Promise<{ statusCode: number; json: () => { error?: { code?: string } } }>) => {
    const answer = await res;
    return [answer.statusCode, answer.json().error?.code];
  };

  it('lets admins write and members only read', async () => {
    const created = await create({ name: '  Security ', content: '# Security\n- check authorization' });
    expect(created.statusCode).toBe(201);
    const skill = created.json().skill;
    expect(skill).toMatchObject({ name: 'Security', content: '# Security\n- check authorization', sizeTokens: 10, usedBy: [] });
    expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const listed = (await list()).json();
    expect(listed.limits).toEqual({ maxSkills: 50, maxTokens: 8000, maxNameLength: 60 });
    expect(listed.skills).toEqual([{ id: skill.id, name: 'Security', sizeTokens: 10, contentHash: skill.contentHash, updatedAt: skill.updatedAt, usedBy: [] }]);
    expect((await read(skill.id)).json().skill.content).toBe('# Security\n- check authorization');

    const member = h.memberCookie();
    expect((await create({ name: 'Other', content: '# x' }, member)).statusCode).toBe(403);
    expect((await update(skill.id, { name: 'Renamed' }, member)).statusCode).toBe(403);
    expect((await remove(skill.id, member)).statusCode).toBe(403);

    const renamed = await update(skill.id, { name: 'Security review' });
    expect(renamed.json().skill).toMatchObject({ name: 'Security review', contentHash: skill.contentHash });
    expect((await update(skill.id, {})).statusCode).toBe(400);
  });

  it('refuses empty, oversized, non-text and secret-bearing content, and taken names', async () => {
    expect(await codeOf(create({ name: 'Blank', content: '  \n' }))).toEqual([400, 'skill_empty']);
    expect(await codeOf(create({ name: 'Huge', content: 'x'.repeat(28_001) }))).toEqual([400, 'skill_too_large']);
    expect(await codeOf(create({ name: 'Binary', content: '# ok\nbad\u0000byte' }))).toEqual([400, 'skill_not_text']);
    const secret = await create({ name: 'Leaky', content: `# Rules\naws ${FAKE_AWS_KEY}` });
    expect([secret.statusCode, secret.json().error.code]).toEqual([400, 'skill_contains_secret']);
    expect(secret.body).not.toContain(FAKE_AWS_KEY);
    expect(await codeOf(create({ name: 'n'.repeat(61), content: '# x' }))).toEqual([400, 'validation_error']);
    expect((await list()).json().skills).toEqual([]);

    // The cap is the engine's estimate: 28,000 characters are 8,000 tokens.
    expect((await create({ name: 'At the cap', content: 'x'.repeat(28_000) })).statusCode).toBe(201);
    expect(await codeOf(create({ name: 'AT THE CAP', content: '# x' }))).toEqual([409, 'skill_name_taken']);
  });

  it("never reads, changes, deletes or selects another workspace's skill", async () => {
    await h.addWorkspace('ws-2');
    const foreign = (await create({ name: 'Foreign', content: '# x' }, h.adminCookie(), 'ws-2')).json().skill;
    expect((await read(foreign.id, h.adminCookie())).statusCode).toBe(404);
    expect((await update(foreign.id, { name: 'Mine' })).statusCode).toBe(404);
    expect((await remove(foreign.id)).statusCode).toBe(404);
    expect(await codeOf(putSettings({ skillId: foreign.id }))).toEqual([400, 'unknown_skill']);
    expect(await codeOf(putBot({ skillId: foreign.id }))).toEqual([400, 'unknown_skill']);
    expect((await read(foreign.id, h.adminCookie(), 'ws-2')).json().skill.name).toBe('Foreign');
  });

  it('selects a skill per bot, and deleting it falls back to Default with a note until a new choice', async () => {
    const skill = (await create({ name: 'Security', content: '# x' })).json().skill;
    expect((await putSettings({ skillId: skill.id })).statusCode).toBe(200);
    expect((await putBot({ skillId: skill.id })).statusCode).toBe(200);
    // A bot save that leaves the skill out keeps it.
    expect((await putBot({ model: 'claude-sonnet-5-5' })).json().bot.skillId).toBe(skill.id);
    expect((await list()).json().skills[0].usedBy).toEqual([1, 2]);

    expect((await remove(skill.id)).statusCode).toBe(204);
    const after = await bots();
    expect(after.main).toMatchObject({ skillRemovedName: 'Security' });
    expect(after.main).not.toHaveProperty('skillId');
    expect(after.bots[0]).toMatchObject({ slot: 2, skillRemovedName: 'Security' });
    expect(after.bots[0]).not.toHaveProperty('skillId');
    expect((await remove(skill.id)).statusCode).toBe(404);

    // Choosing Default (null) clears the note.
    expect((await putBot({ skillId: null })).json().bot).not.toHaveProperty('skillRemovedName');
    expect((await putSettings({ skillId: null })).statusCode).toBe(200);
    expect((await bots()).main).not.toHaveProperty('skillRemovedName');
  });
});

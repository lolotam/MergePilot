import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackupHarness, exportBackup, PASSPHRASE, restoreBackup, seedWorkspace, type BackupHarness } from './backup-routes.fixtures.js';

// Review skills in the settings backup (ADR-0034, ADR-0018): skills travel with their content and
// bots name theirs by name, because skill ids differ between workspaces.

describe('settings backup — review skills (ADR-0034)', { timeout: 60000 }, () => {
  let h: BackupHarness;

  beforeEach(async () => {
    h = await createBackupHarness();
    await seedWorkspace(h);
  }, 60000);

  afterEach(async () => {
    await h.close();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, ws: string, payload?: Record<string, unknown>) =>
    h.app.inject({ method, url: `/api/workspaces/${ws}/${path}`, headers: { cookie: h.cookie('owner') }, ...(payload ? { payload } : {}) });
  const addSkill = async (ws: string, name: string, content: string): Promise<string> =>
    (await call('POST', 'skills', ws, { name, content })).json().skill.id;
  // With the keys: the restored settings need the providers' keys in the target workspace.
  const exported = async () => (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
  const restore = async (file: unknown, sections?: string[]) =>
    restoreBackup(h, { file, passphrase: PASSPHRASE, ...(sections ? { sections } : {}) });

  /** ws-1: the main bot on "Security", extra bot 2 on "Cross-file". */
  async function useSkills(): Promise<void> {
    const security = await addSkill('ws-1', 'Security', '# Security');
    const crossFile = await addSkill('ws-1', 'Cross-file', '# Cross-file');
    const settings = (await call('GET', 'settings', 'ws-1')).json().settings;
    expect((await call('PUT', 'settings', 'ws-1', { ...settings, skillId: security })).statusCode).toBe(200);
    const bot = (await call('GET', 'bots', 'ws-1')).json().bots.find((b: { slot: number }) => b.slot === 2);
    expect((await call('PUT', 'bots/2', 'ws-1', { ...bot, skillId: crossFile })).statusCode).toBe(200);
  }

  it('exports skills with their content and names each bot skill, never an id', async () => {
    await useSkills();
    const file = await exported();
    expect(file.skills).toEqual([
      { name: 'Cross-file', content: '# Cross-file' },
      { name: 'Security', content: '# Security' },
    ]);
    expect(file.settings.skillName).toBe('Security');
    expect(file.settings).not.toHaveProperty('skillId');
    expect(file.bots.find((b: { slot: number }) => b.slot === 2)).toMatchObject({ skillName: 'Cross-file' });
    expect(JSON.stringify(file)).not.toMatch(/"skillId"/);
  });

  it('restores skills into another workspace and maps the bots to its own skill ids', async () => {
    await useSkills();
    await addSkill('ws-2', 'security', '# old text');
    const res = await restore(await exported());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ skills: 2, skillsMissing: [] });

    const skills = (await call('GET', 'skills', 'ws-2')).json().skills;
    // The same-named skill of ws-2 is replaced, keeping its id; the other one is added.
    expect(skills.map((s: { name: string }) => s.name)).toEqual(['Cross-file', 'Security']);
    const byName = Object.fromEntries(skills.map((s: { name: string; id: string; usedBy: number[] }) => [s.name, s]));
    expect((await call('GET', `skills/${byName.Security.id}`, 'ws-2')).json().skill.content).toBe('# Security');
    expect(byName.Security.usedBy).toEqual([1]);
    expect(byName['Cross-file'].usedBy).toEqual([2]);
  });

  it('restores a bot whose named skill will not exist on Default, and says so in the preview', async () => {
    await useSkills();
    const file = await exported();
    const res = await restore(file, ['settings', 'bots', 'credentials']);
    expect(res.json()).toMatchObject({ skills: 0, skillsMissing: ['Cross-file', 'Security'] });
    const bots = (await call('GET', 'bots', 'ws-2')).json();
    expect(bots.main).not.toHaveProperty('skillId');
    expect(bots.bots.every((b: Record<string, unknown>) => !('skillId' in b))).toBe(true);
  });

  it.each([
    ['a skill name that is not a string', { settings: { skillName: 42 } }, 'validation_error', 'settings.skillName'],
    ['a credential as a bot skill name', { bot: { skillName: ['AKIA', 'Q'.repeat(16)].join('') } }, 'skill_has_credential', 'bots[0].skillName'],
  ])('refuses %s without echoing it, writing nothing', async (_case, edit, code, field) => {
    const file = await exported();
    const hand = {
      ...file,
      settings: { ...file.settings, ...('settings' in edit ? edit.settings : {}) },
      bots: file.bots.map((b: Record<string, unknown>, i: number) => (i === 0 && 'bot' in edit ? { ...b, ...edit.bot } : b)),
    };
    const res = await restore(hand);
    expect([res.statusCode, res.json().error.code, res.json().error.field]).toEqual([400, code, field]);
    expect(res.body).not.toContain('Q'.repeat(16));
    expect((await call('GET', 'bots', 'ws-2')).json().bots).toEqual([]);
  });

  it('refuses a hand-edited skill that breaks the upload rules, writing nothing', async () => {
    const file = { ...(await exported()), skills: [{ name: 'Leaky', content: ' ' }] };
    const res = await restore(file);
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'skill_empty']);
    expect((await call('GET', 'skills', 'ws-2')).json().skills).toEqual([]);
  });
});

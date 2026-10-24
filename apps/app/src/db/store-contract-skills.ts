import { expect, it } from 'vitest';
import {
  MAX_WORKSPACE_SKILLS,
  SkillLimitError,
  SkillNameTakenError,
  UnknownSkillError,
  type AppStore,
  type NewReviewRun,
  type NewReviewSkill,
  type ReviewerBot,
  type WorkspaceSettings,
} from '../core/types.js';

const WS = 'ws-skills';
const WS_OTHER = 'ws-skills-other';

let counter = 0;
const newSkill = (overrides: Partial<NewReviewSkill> = {}): NewReviewSkill => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    name: `Skill ${counter}`,
    content: '# Security\n- check authorization',
    contentHash: 'a'.repeat(64),
    sizeTokens: 10,
    userId: 'u-admin',
    ...overrides,
  };
};

const settings = (overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings => ({
  workspaceId: WS,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  language: 'en',
  monthlyBudgetUsd: null,
  ...overrides,
});

const bot = (overrides: Partial<ReviewerBot> = {}): ReviewerBot => ({
  slot: 2,
  name: 'Owl',
  logo: 'owl',
  active: true,
  provider: 'openai',
  model: 'gpt-5',
  effort: null,
  fallback: [],
  exploreEnabled: false,
  ...overrides,
});

/** Review skills (ADR-0034): per-workspace storage, bot selection, and delete falling back to Default. */
export function defineReviewSkillContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  it('creates, lists by name, updates and isolates skills per workspace', async () => {
    const store = await createStore();
    try {
      const security = await store.createReviewSkill(WS, newSkill({ name: 'Security' }));
      const rules = await store.createReviewSkill(WS, newSkill({ name: 'owner rules', content: '# Rules' }));
      expect(security).toMatchObject({ workspaceId: WS, name: 'Security', createdBy: 'u-admin', updatedBy: 'u-admin' });

      const listed = await store.listReviewSkills(WS);
      expect(listed.map((s) => s.name)).toEqual(['owner rules', 'Security']);
      expect(listed[0]).not.toHaveProperty('content');
      expect((await store.getReviewSkill(WS, rules.id))?.content).toBe('# Rules');

      // Another workspace can neither see, change nor delete it.
      expect(await store.listReviewSkills(WS_OTHER)).toEqual([]);
      expect(await store.getReviewSkill(WS_OTHER, security.id)).toBeNull();
      expect(await store.updateReviewSkill(WS_OTHER, security.id, { name: 'Taken', userId: 'u-x' })).toBeNull();
      expect(await store.deleteReviewSkill(WS_OTHER, security.id)).toBeNull();
      expect(await store.getReviewSkill(WS, 'not-a-uuid')).toBeNull();

      const updated = await store.updateReviewSkill(WS, security.id, {
        content: { text: '# Security v2', hash: 'b'.repeat(64), sizeTokens: 4 },
        userId: 'u-editor',
      });
      expect(updated).toMatchObject({
        name: 'Security',
        content: '# Security v2',
        contentHash: 'b'.repeat(64),
        sizeTokens: 4,
        updatedBy: 'u-editor',
      });
    } finally {
      await cleanup?.();
    }
  });

  it('keeps names unique per workspace ignoring case, and caps the count', async () => {
    const store = await createStore();
    try {
      const first = await store.createReviewSkill(WS, newSkill({ name: 'Security' }));
      await expect(store.createReviewSkill(WS, newSkill({ name: 'SECURITY' }))).rejects.toBeInstanceOf(SkillNameTakenError);
      const other = await store.createReviewSkill(WS, newSkill({ name: 'Rules' }));
      await expect(store.updateReviewSkill(WS, other.id, { name: 'security', userId: 'u' })).rejects.toBeInstanceOf(SkillNameTakenError);
      // A skill may change the case of its own name; another workspace may reuse it.
      expect((await store.updateReviewSkill(WS, first.id, { name: 'SECURITY', userId: 'u' }))?.name).toBe('SECURITY');
      await store.createReviewSkill(WS_OTHER, newSkill({ name: 'Security' }));

      for (let i = 2; i < MAX_WORKSPACE_SKILLS; i++) await store.createReviewSkill(WS, newSkill({ name: `Extra ${i}` }));
      expect(await store.listReviewSkills(WS)).toHaveLength(MAX_WORKSPACE_SKILLS);
      await expect(store.createReviewSkill(WS, newSkill({ name: 'One too many' }))).rejects.toBeInstanceOf(SkillLimitError);
    } finally {
      await cleanup?.();
    }
  });

  it('lets a bot use only its own workspace skill; deleting it falls back to Default with a note', async () => {
    const store = await createStore();
    try {
      const own = await store.createReviewSkill(WS, newSkill({ name: 'Security' }));
      const foreign = await store.createReviewSkill(WS_OTHER, newSkill({ name: 'Foreign' }));
      await expect(store.saveSettings(settings({ skillId: foreign.id }))).rejects.toBeInstanceOf(UnknownSkillError);
      await expect(store.upsertReviewerBot(WS, bot({ skillId: foreign.id }))).rejects.toBeInstanceOf(UnknownSkillError);
      await expect(store.saveSettings(settings({ skillId: 'not-a-uuid' }))).rejects.toBeInstanceOf(UnknownSkillError);
      await expect(store.upsertReviewerBot(WS, bot({ skillId: 'not-a-uuid' }))).rejects.toBeInstanceOf(UnknownSkillError);
      await expect(store.saveSettings(settings({ skillId: '' }))).rejects.toBeInstanceOf(UnknownSkillError);
      await expect(store.upsertReviewerBot(WS, bot({ skillId: '' }))).rejects.toBeInstanceOf(UnknownSkillError);

      await store.saveSettings(settings({ skillId: own.id }));
      await store.upsertReviewerBot(WS, bot({ skillId: own.id }));
      expect((await store.getSettings(WS))?.skillId).toBe(own.id);
      expect(await store.listReviewerBots(WS)).toEqual([bot({ skillId: own.id })]);
      // A save that leaves the skill out keeps it.
      await store.saveSettings(settings({ model: 'claude-opus-5-5' }));
      expect((await store.getSettings(WS))?.skillId).toBe(own.id);

      expect(await store.deleteReviewSkill(WS, own.id)).toEqual({ name: 'Security', fellBackSlots: [1, 2] });
      expect(await store.getReviewSkill(WS, own.id)).toBeNull();
      const main = await store.getSettings(WS);
      expect(main).not.toHaveProperty('skillId');
      expect(main?.skillRemovedName).toBe('Security');
      expect(await store.listReviewerBots(WS)).toEqual([bot({ skillRemovedName: 'Security' })]);

      // A bot save that leaves the skill out keeps the note too, inside the write.
      await store.upsertReviewerBot(WS, bot({ model: 'gpt-5-mini' }));
      expect(await store.listReviewerBots(WS)).toEqual([bot({ model: 'gpt-5-mini', skillRemovedName: 'Security' })]);

      // Saving without a skill keeps the note; choosing Default (null) clears it.
      await store.saveSettings(settings());
      expect((await store.getSettings(WS))?.skillRemovedName).toBe('Security');
      await store.saveSettings(settings({ skillId: null }));
      expect(await store.getSettings(WS)).not.toHaveProperty('skillRemovedName');
    } finally {
      await cleanup?.();
    }
  });

  it("records the run's skill by name, and a retry of the same job on Default drops it", async () => {
    const store = await createStore();
    try {
      const run = (overrides: Partial<NewReviewRun>): NewReviewRun => ({
        workspaceId: WS, jobId: 'job-skill', installationId: 9, repoFullName: 'org/skills', pullNumber: 3,
        headSha: 'sha-skill', status: 'running', costUsd: null, detail: null, ...overrides,
      });
      const first = await store.createReviewRun(run({ skillName: 'Security' }));
      expect((await store.getReviewRun(WS, first.id))?.skillName).toBe('Security');
      await store.finishReviewRun(WS, first.id, { status: 'failed', costUsd: null, detail: 'boom' });

      const retry = await store.createReviewRun(run({}));
      expect(retry.id).toBe(first.id);
      expect(await store.getReviewRun(WS, first.id)).not.toHaveProperty('skillName');
    } finally {
      await cleanup?.();
    }
  });

  it('refuses a restore that would pass the skill limit, writing nothing', async () => {
    const store = await createStore();
    try {
      for (let i = 1; i < MAX_WORKSPACE_SKILLS; i++) await store.createReviewSkill(WS, newSkill({ name: `Kept ${i}` }));
      const attempt = store.restoreWorkspace(WS, {
        skills: [newSkill({ name: 'New A' }), newSkill({ name: 'New B' })],
        bots: [bot()],
      });
      await expect(attempt).rejects.toBeInstanceOf(SkillLimitError);
      expect(await store.listReviewSkills(WS)).toHaveLength(MAX_WORKSPACE_SKILLS - 1);
      expect(await store.listReviewerBots(WS)).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('refuses a restore whose planned skill was renamed since the plan, writing nothing', async () => {
    const store = await createStore();
    try {
      const renamed = await store.createReviewSkill(WS, newSkill({ name: 'Frontend' }));
      // The plan matched "Security" to this id before an admin renamed it to "Frontend".
      const attempt = store.restoreWorkspace(WS, { skills: [{ ...newSkill({ name: 'Security' }), id: renamed.id }] });
      await expect(attempt).rejects.toBeInstanceOf(SkillNameTakenError);
      expect((await store.getReviewSkill(WS, renamed.id))?.name).toBe('Frontend');
    } finally {
      await cleanup?.();
    }
  });

  it("never overwrites another workspace's skill that has the same id", async () => {
    const store = await createStore();
    try {
      const foreign = await store.createReviewSkill(WS_OTHER, newSkill({ name: 'Foreign' }));
      const attempt = store.restoreWorkspace(WS, { skills: [{ ...newSkill({ name: 'Mine' }), id: foreign.id }] });
      await expect(attempt).rejects.toThrow();
      expect(await store.getReviewSkill(WS_OTHER, foreign.id)).toMatchObject({ name: 'Foreign', content: foreign.content });
      expect(await store.listReviewSkills(WS)).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  it('restores skills by id: a same-id skill is replaced, a new one inserted, and bots may use them', async () => {
    const store = await createStore();
    try {
      const kept = await store.createReviewSkill(WS, newSkill({ name: 'Kept' }));
      const replaced = await store.createReviewSkill(WS, newSkill({ name: 'Security' }));
      const added = newSkill({ name: 'Cross-file' });
      await store.restoreWorkspace(WS, {
        skills: [
          { id: replaced.id, name: 'Security', content: '# Restored', contentHash: 'c'.repeat(64), sizeTokens: 3, userId: 'u-restore' },
          added,
        ],
        bots: [bot({ skillId: added.id })],
      });
      expect((await store.listReviewSkills(WS)).map((s) => s.name)).toEqual(['Cross-file', 'Kept', 'Security']);
      expect((await store.getReviewSkill(WS, replaced.id))?.content).toBe('# Restored');
      expect((await store.getReviewSkill(WS, kept.id))?.content).toBe(kept.content);
      expect(await store.listReviewerBots(WS)).toEqual([bot({ skillId: added.id })]);
    } finally {
      await cleanup?.();
    }
  });
}

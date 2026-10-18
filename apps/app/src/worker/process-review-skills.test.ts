import { describe, expect, it } from 'vitest';
import { estimateTokens, skillContentHash } from '@mergepilot/engine';
import type { ReviewerBot, WorkspaceSettings } from '../core/types.js';
import { finding, panelSetup, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// Review skills in the worker (ADR-0034): each bot reviews with its own skill on top of the core
// prompt, the run and the summary name it, and the marker hash follows the skill.

type Setup = Awaited<ReturnType<typeof panelSetup>>;

async function addSkill(h: Setup, name: string, content: string): Promise<string> {
  const skill = await h.store.createReviewSkill(WS, {
    id: crypto.randomUUID(),
    name,
    content,
    contentHash: skillContentHash(content),
    sizeTokens: estimateTokens(content),
    userId: 'u-admin',
  });
  return skill.id;
}

async function useSkill(h: Setup, slot: number, skillId: string | null): Promise<void> {
  if (slot === 1) {
    const settings = (await h.store.getSettings(WS)) as WorkspaceSettings;
    await h.store.saveSettings({ ...settings, skillId });
    return;
  }
  const bot = (await h.store.listReviewerBots(WS)).find((b) => b.slot === slot) as ReviewerBot;
  await h.store.upsertReviewerBot(WS, { ...bot, skillId });
}

const configHashOf = (body: string) => /config=([0-9a-f]+)/.exec(body)?.[1];
const reviewSystems = (h: Setup, model: string) =>
  h.systems.filter((s) => s.model === model && !s.system.startsWith("You are verifying another reviewer's findings"));

describe('processReviewJob — review skills (ADR-0034)', () => {
  it('gives each bot its own skill, records it on the run and names it in the summary', async () => {
    const h = await panelSetup({ bots: [{ slot: 2, name: 'Owl' }, { slot: 3, name: 'Fox' }] });
    await useSkill(h, 1, await addSkill(h, 'Security', '- check every route for authorization'));
    await useSkill(h, 2, await addSkill(h, 'Cross-file', '- check every consumer'));

    expect((await processReviewJob(h.job, h.deps)).status).toBe('completed');

    const main = reviewSystems(h, 'main-model');
    expect(main.length).toBeGreaterThan(0);
    expect(main.every((s) => s.system.endsWith('<<<REVIEW_SKILL:Security>>>\n- check every route for authorization\n<<<END REVIEW_SKILL:Security>>>'))).toBe(true);
    expect(reviewSystems(h, 'bot2-model').every((s) => s.system.includes('<<<REVIEW_SKILL:Cross-file>>>'))).toBe(true);
    const fox = reviewSystems(h, 'bot3-model');
    expect(fox.length).toBeGreaterThan(0);
    expect(fox.every((s) => !s.system.includes('REVIEW_SKILL') && !s.system.includes('REVIEW SKILL'))).toBe(true);

    expect((await h.runs()).map((r) => [r.botSlot, r.skillName ?? null])).toEqual([[1, 'Security'], [2, 'Cross-file'], [3, null]]);
    const bodies = h.created.map((c) => c.body);
    expect(bodies.some((b) => b.includes('**MergePilot** · `anthropic:main-model` · skill: Security'))).toBe(true);
    expect(bodies.some((b) => b.includes('**Owl** · `openai:bot2-model` · skill: Cross-file'))).toBe(true);
    expect(bodies.some((b) => b.includes('**Fox** · `openai:bot3-model`\n'))).toBe(true);
  });

  it('shows a lone bot its identity line only to name its skill', async () => {
    const plain = await panelSetup();
    await processReviewJob(plain.job, plain.deps);
    expect(plain.created[0]!.body).not.toContain('**MergePilot**');

    const skilled = await panelSetup();
    await useSkill(skilled, 1, await addSkill(skilled, 'Owner rules', '- apply AGENTS.md'));
    await processReviewJob(skilled.job, skilled.deps);
    expect(skilled.created[0]!.body).toContain('**MergePilot** · `anthropic:main-model` · skill: Owner rules');
  });

  it("changes the marker hash with the skill's text, and keeps it on Default", async () => {
    const hashWith = async (content: string | null) => {
      const h = await panelSetup();
      if (content !== null) await useSkill(h, 1, await addSkill(h, 'Security', content));
      await processReviewJob(h.job, h.deps);
      return configHashOf(h.created[0]!.body);
    };
    const none = await hashWith(null);
    const first = await hashWith('- one');
    expect(first).not.toBe(none);
    expect(await hashWith('- two')).not.toBe(first);
    expect(await hashWith('- one')).toBe(first);
  });

  it("in consensus, an extra bot's skill changes the panel's marker hash and shows in the bots table", async () => {
    const consensus = { settings: { panelMode: 'consensus' as const }, bots: [{ slot: 2, name: 'Owl' }], findings: { 'main-model': [finding('Alpha')] } };
    const plain = await panelSetup(consensus);
    await processReviewJob(plain.job, plain.deps);

    const skilled = await panelSetup(consensus);
    await useSkill(skilled, 2, await addSkill(skilled, 'Security', '- check authz'));
    await processReviewJob(skilled.job, skilled.deps);

    expect(skilled.created).toHaveLength(1);
    expect(configHashOf(skilled.created[0]!.body)).not.toBe(configHashOf(plain.created[0]!.body));
    expect(skilled.created[0]!.body).toContain('| **Owl** | `openai:bot2-model` | Security |');
  });
});

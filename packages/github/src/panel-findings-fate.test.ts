import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { capConsensusClusters, mergePanelFindings, type PanelBotFindings } from './consensus.js';
import { botFindingsFates } from './panel-findings-fate.js';
import { renderPanelSummary, type PanelBotRow } from './panel-summary.js';

// ADR-0034 amendment: a bot's count in the panel table is explained when it published fewer
// findings as its own comment (the eval's MP#156 run: Hamza_Bot "1" with nothing posted).

const f = (over: Partial<Finding>): Finding => ({
  id: over.title ?? 'f',
  path: 'src/a.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Issue',
  body: 'Body.',
  severity: 'medium',
  category: 'correctness',
  evidence: 'e',
  confidence: 0.9,
  ...over,
});

const bots: PanelBotFindings[] = [
  { slot: 1, name: 'Pilot', inline: [f({ title: 'Shared', severity: 'high' }), f({ title: 'Lonely', path: 'b.ts' })], summaryOnly: [] },
  {
    slot: 2,
    name: 'Owl',
    inline: [f({ title: 'Shared' }), f({ title: 'Posted before', path: 'c.ts' }), f({ title: 'Agreed', path: 'd.ts' })],
    summaryOnly: [],
  },
  { slot: 3, name: 'Fox', inline: [f({ title: 'Posted before', path: 'c.ts' }), f({ title: 'Agreed', path: 'd.ts' })], summaryOnly: [] },
];

const rows: PanelBotRow[] = bots.map((b) => ({
  slot: b.slot, name: b.name, logo: 'pilot', modelLabel: 'm:x', status: 'completed', findings: b.inline.length,
}));

/** The worker's flow: merge, drop the clusters already on the PR, cap the rest. */
async function outcome(maxFindings?: number) {
  const merge = await mergePanelFindings({ bots, minAgreement: 2 });
  const alreadyPosted = merge.kept.filter((c) => c.finding.title === 'Posted before');
  const capped = capConsensusClusters(merge.kept.filter((c) => !alreadyPosted.includes(c)), maxFindings);
  return { merge, fates: botFindingsFates(bots, { published: capped.kept, below: merge.below, overLimit: capped.overLimit, alreadyPosted }) };
}

describe('botFindingsFates', () => {
  it('says for each bot where every finding went, and the parts add up to its table count', async () => {
    const { fates } = await outcome(1);

    expect(fates).toEqual([
      { slot: 1, name: 'Pilot', reported: 2, own: 1, mergedIntoOther: 0, below: 1, overLimit: 0, alreadyPosted: 0 },
      { slot: 2, name: 'Owl', reported: 3, own: 0, mergedIntoOther: 1, below: 0, overLimit: 1, alreadyPosted: 1 },
      { slot: 3, name: 'Fox', reported: 2, own: 0, mergedIntoOther: 0, below: 0, overLimit: 1, alreadyPosted: 1 },
    ]);
    for (const fate of fates) {
      expect(fate.own + fate.mergedIntoOther + fate.below + fate.overLimit + fate.alreadyPosted).toBe(fate.reported);
    }
  });
});

describe('renderPanelSummary — where the table findings went', () => {
  it('names each bot that published fewer than its count, with the reasons, in English and Arabic', async () => {
    const { merge, fates } = await outcome(1);
    const input = { baseUrl: 'https://mp.example.com', bots: rows, merge, minAgreement: 2, inlineCount: 1, findingsFates: fates };

    const en = renderPanelSummary({ ...input, language: 'en' });
    expect(en).toContain("> ℹ️ Findings counted in the table but not published as the bot's own comment:");
    expect(en).toContain('> - **Pilot** (1 of 2): 1 below agreement');
    expect(en).toContain(
      "> - **Owl** (3 of 3): 1 merged into another bot's comment on the same issue · 1 over the findings limit · 1 already posted by an earlier review",
    );

    const ar = renderPanelSummary({ ...input, language: 'ar' });
    expect(ar).toContain('> - **Fox** (2 من 2): 1 فوق الحد الأقصى للملاحظات · 1 منشورة من مراجعة سابقة');
  });

  it('points to the verification list when a bot also had findings rejected there', async () => {
    const { merge, fates } = await outcome(1);
    const body = renderPanelSummary({
      language: 'en', bots: rows, merge, minAgreement: 2, inlineCount: 1, findingsFates: fates,
      verifyRejected: [{ title: 'Wrong', path: 'e.ts', line: 1, bot: 'Fox' }],
    });
    expect(body).toContain('> Findings rejected by verification are not counted in the table');
  });

  it('adds nothing when every bot published all it reported as its own comment', async () => {
    const solo: PanelBotFindings[] = [{ slot: 1, name: 'Pilot', inline: [f({ title: 'Only' })], summaryOnly: [] }];
    const merge = await mergePanelFindings({ bots: solo, minAgreement: 1 });
    const fates = botFindingsFates(solo, { published: merge.kept, below: [], overLimit: [], alreadyPosted: [] });
    const body = renderPanelSummary({ language: 'en', bots: rows.slice(0, 1), merge, minAgreement: 1, inlineCount: 1, findingsFates: fates });
    expect(body).not.toContain('not published as the bot');
  });
});

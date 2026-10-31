import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { mergePanelFindings, type PanelBotFindings } from './consensus.js';
import { botFindingsFates } from './panel-findings-fate.js';
import { renderPanelSummary } from './panel-summary.js';

const f = (over: Partial<Finding> = {}): Finding => ({
  id: 'claim', path: 'src/a.ts', line: 10, side: 'RIGHT', title: 'Null dereference',
  body: 'x may be null.', severity: 'medium', category: 'correctness', evidence: 'x.y', confidence: 0.9, ...over,
});
const bot = (slot: number, name: string, inline: Finding[]): PanelBotFindings => ({ slot, name, inline, summaryOnly: [] });
const rejectedBot = (slot: number): PanelBotFindings => ({
  ...bot(slot, `Bot ${slot}`, []), rejected: [{ finding: f(), reason: 'Contradicted', kind: 'inline' }],
});

describe('consensus rejection ordering and disclosures — PR189', () => {
  it.each(['title', 'claim'])('forms kept claim clusters before a rejected %s match consumes a bot slot (PR189)', async (match) => {
    const body = 'Replaying the retained request replaces the authoritative session total with a stale cached response.';
    const first = f({ title: 'Equal revision replays overwrite totals', body });
    const second = f({ title: 'Cached replay replaces authoritative figures', body });
    const rejected = f({ ...second, title: match === 'title' ? second.title : 'Cached replay replaces authoritative figures incorrectly' });
    const merge = await mergePanelFindings({
      bots: [{ ...bot(1, 'Main', [first]), rejected: [{ finding: rejected, reason: 'Contradicted', kind: 'inline' }] }, bot(2, 'Owl', [second])],
      minAgreement: 1,
    });
    expect(merge.kept).toHaveLength(1);
    expect(merge.kept[0]!.finding).toBe(first);
    expect(merge.kept[0]!.foundBy.map(({ slot }) => slot)).toEqual([1, 2]);
    expect(merge.kept[0]!.rejectedBy).toBeUndefined();
  });

  it.each(['below', 'overLimit'] as const)('does not claim publication for rejected-only clusters placed %s (PR189)', async (outcome) => {
    const bots = [rejectedBot(1), rejectedBot(2)];
    const merge = await mergePanelFindings({ bots, minAgreement: outcome === 'below' ? 3 : 2, ...(outcome === 'overLimit' ? { maxFindings: 0 } : {}) });
    expect(merge.kept).toHaveLength(0);
    expect(merge[outcome]).toHaveLength(1);
    for (const language of ['en', 'ar'] as const) {
      const summary = renderPanelSummary({ language, bots: [], merge, minAgreement: 3, inlineCount: 0 });
      expect(summary).toContain(language === 'en' ? 'Unverified: verifier-rejected' : 'غير متحققة: رفضها التحقق');
      expect(summary).not.toContain(language === 'en' ? 'published although' : 'نُشرت رغم');
      expect(summary).not.toContain(language === 'en' ? 'Published although' : 'منشورة رغم');
    }
  });

  it.each([false, true])('separates rejected-copy fates from table-count fates (has kept copies=%s)', async (hasKept) => {
    const bots = hasKept ? [bot(1, 'Main', [f()]), bot(2, 'Owl', [f()]), rejectedBot(3)] : [rejectedBot(1), rejectedBot(2)];
    const merge = await mergePanelFindings({ bots, minAgreement: 2 });
    const findingsFates = botFindingsFates(bots, { published: merge.kept, below: [], overLimit: [], alreadyPosted: [] });
    for (const language of ['en', 'ar'] as const) {
      const summary = renderPanelSummary({ language, bots: [], merge, findingsFates, minAgreement: 2, inlineCount: 1 });
      const rejectedHeading = language === 'en'
        ? '> ℹ️ Verifier-rejected copies incorporated in clusters (excluded from the table count):'
        : '> ℹ️ نسخ رفضها التحقق دخلت في التجميع (خارج عدد الجدول):';
      expect(summary).toContain(rejectedHeading);
      expect(summary.split(rejectedHeading)[1]).toContain(`**Bot ${hasKept ? 3 : 2}**`);
      const countedHeading = language === 'en' ? 'Findings counted in the table but' : 'ملاحظات محسوبة في الجدول';
      expect(summary.includes(countedHeading)).toBe(hasKept);
      if (hasKept) expect(summary.indexOf(countedHeading)).toBeLessThan(summary.indexOf(rejectedHeading));
    }
  });
});

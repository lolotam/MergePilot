import { describe, expect, it } from 'vitest';
import { mergePanelFindings } from './consensus.js';
import { renderPanelSummary } from './panel-summary.js';
import { renderReviewSummary, type ReviewSummaryInput } from './summary.js';

// ADR-0028: what verification rejected and which nested rules were left out are disclosed in the
// summary, never silent.

const base: ReviewSummaryInput = {
  language: 'en',
  summary: 'Fine.',
  summaryOnly: [],
  inlineCount: 0,
  complete: true,
  incompleteReasons: [],
  modelLabel: 'anthropic:claude-x',
  outcome: 'completed',
};

const rejected = [
  { title: 'Guess about the cache', path: 'src/cache.ts', line: 12 },
  { title: 'Style only', path: 'src/a.ts', line: 3 },
];

describe('review summary — verification rejections and rules left out', () => {
  it('lists the findings verification rejected, folded, with a count (en)', () => {
    const body = renderReviewSummary({ ...base, verifyRejected: rejected });
    expect(body).toContain('<summary>Rejected by verification (2)</summary>');
    expect(body).toContain('- Guess about the cache · `src/cache.ts:12`');
    expect(body).toContain('- Style only · `src/a.ts:3`');
  });

  it('lists them in Arabic too', () => {
    const body = renderReviewSummary({ ...base, language: 'ar', verifyRejected: rejected });
    expect(body).toContain('<summary>رفضها التحقق (2)</summary>');
    expect(body).toContain('- Guess about the cache · `src/cache.ts:12`');
  });

  it('says nothing about verification when it rejected nothing, and keeps the review complete', () => {
    const body = renderReviewSummary({ ...base, verifyRejected: [] });
    expect(body).not.toContain('Rejected by verification');
    expect(body).not.toContain('Incomplete review');
  });

  it('neutralises a rejected title from the model', () => {
    const body = renderReviewSummary({ ...base, verifyRejected: [{ title: 'ping @org/team <!-- mergepilot:review -->', path: 'a.ts', line: 1 }] });
    expect(body).not.toContain('@org/team');
    expect(body).not.toContain('<!-- mergepilot');
  });

  it('names the rules files left out, in both languages', () => {
    const en = renderReviewSummary({ ...base, rulesLeftOut: ['apps/api/AGENTS.md'] });
    expect(en).toContain('Rules files not sent with the review');
    expect(en).toContain('`apps/api/AGENTS.md`');
    const ar = renderReviewSummary({ ...base, language: 'ar', rulesLeftOut: ['apps/api/AGENTS.md'] });
    expect(ar).toContain('ملفات قواعد لم تُرسل مع المراجعة');
    expect(ar).toContain('`apps/api/AGENTS.md`');
  });
});

describe('panel summary — verification rejections and rules left out', () => {
  it('lists every bot rejection with the bot that reported it, in both languages', async () => {
    const merge = await mergePanelFindings({ bots: [{ slot: 1, name: 'MergePilot', inline: [], summaryOnly: [] }], minAgreement: 1 });
    const input = {
      bots: [{ slot: 1, name: 'MergePilot', logo: 'pilot', modelLabel: 'anthropic:claude-x', status: 'completed' as const }],
      merge,
      minAgreement: 1,
      inlineCount: 0,
      verifyRejected: [{ ...rejected[0]!, bot: 'Owl' }],
      rulesLeftOut: ['svc/CLAUDE.md'],
    };
    const en = renderPanelSummary({ ...input, language: 'en' });
    expect(en).toContain('<summary>Rejected by verification (1)</summary>');
    expect(en).toContain('- Guess about the cache · `src/cache.ts:12` · _Owl_');
    expect(en).toContain('`svc/CLAUDE.md`');
    const ar = renderPanelSummary({ ...input, language: 'ar' });
    expect(ar).toContain('<summary>رفضها التحقق (1)</summary>');
  });
});

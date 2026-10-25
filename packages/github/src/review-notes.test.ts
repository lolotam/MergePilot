import { describe, expect, it } from 'vitest';
import { mergePanelFindings } from './consensus.js';
import { renderPanelSummary } from './panel-summary.js';
import { renderExplorationNote } from './review-notes.js';
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

describe('the exploration note (ADR-0046)', () => {
  it('uses plural English count words', () => {
    const note = renderExplorationNote(
      { rounds: 2, verifierRounds: 0, requests: 3, filesRead: ['src/a.ts', 'src/b.ts'], refused: 2 },
      false,
    );
    expect(note).toBe('> ℹ️ Explored: 2 files in 2 rounds, 2 requests refused');
  });

  it('uses singular English count words', () => {
    const note = renderExplorationNote(
      { rounds: 1, verifierRounds: 0, requests: 2, filesRead: ['src/a.ts'], refused: 1 },
      false,
    );
    expect(note).toBe('> ℹ️ Explored: 1 file in 1 round, 1 request refused');
  });

  it('discloses one verifier round separately', () => {
    const note = renderExplorationNote(
      { rounds: 2, verifierRounds: 1, requests: 3, filesRead: ['src/a.ts'], refused: 0 },
      false,
    );
    expect(note).toBe('> ℹ️ Explored: 1 file in 2 rounds, verifier read once');
  });

  it('discloses several verifier rounds separately', () => {
    const note = renderExplorationNote(
      { rounds: 0, verifierRounds: 2, requests: 0, filesRead: [], refused: 0 },
      false,
    );
    expect(note).toBe('> ℹ️ Explored: 0 files in 0 rounds, verifier: 2 rounds');
  });

  it('says why the exploration was skipped', () => {
    const note = renderExplorationNote(
      { rounds: 0, verifierRounds: 0, requests: 0, filesRead: [], refused: 0, skipped: 'batched review' },
      false,
    );
    expect(note).toBe('> ℹ️ Explored: 0 files in 0 rounds (skipped: batched review)');
  });

  it('says nothing when there was no exploration', () => {
    expect(renderExplorationNote(undefined, false)).toBeUndefined();
    expect(
      renderExplorationNote({ rounds: 0, verifierRounds: 0, requests: 0, filesRead: [], refused: 0 }, false),
    ).toBeUndefined();
  });

  it('speaks Arabic too', () => {
    expect(
      renderExplorationNote(
        { rounds: 2, verifierRounds: 1, requests: 3, filesRead: ['src/a.ts', 'src/b.ts'], refused: 1 },
        true,
      ),
    ).toBe('> ℹ️ الاستكشاف: 2 ملف في 2 جولة، والتحقق قرا مرة، 1 طلب مرفوض');
    expect(
      renderExplorationNote(
        { rounds: 0, verifierRounds: 2, requests: 0, filesRead: [], refused: 0 },
        true,
      ),
    ).toBe('> ℹ️ الاستكشاف: 0 ملف في 0 جولة، والتحقق: 2 جولة');
    expect(
      renderExplorationNote(
        { rounds: 0, verifierRounds: 0, requests: 0, filesRead: [], refused: 0, skipped: 'batched review' },
        true,
      ),
    ).toBe('> ℹ️ الاستكشاف: 0 ملف في 0 جولة (اتخطى: batched review)');
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

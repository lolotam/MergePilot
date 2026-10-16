import { describe, expect, it } from 'vitest';
import { contextDisclosureOf } from './review-context.js';
import { mergeContextDisclosures, renderContextNote } from './review-notes.js';

// ADR-0030: the summary says how much of the rest of the PR a follow-up review saw and how many
// open findings it re-checked, in English and Arabic, merged across the bots of a panel.

describe('follow-up disclosure', () => {
  const disclosure = contextDisclosureOf(
    { sent: ['src/dep.ts'], leftOut: [], pr: { sent: ['a.ts', 'b.ts'], leftOut: ['c.ts'] } },
    [],
    { shown: ['41', '42', '43'] },
  );

  it('adds the PR context and open findings lines to the repository context line', () => {
    expect(renderContextNote(disclosure, false)).toBe(
      [
        '> ℹ️ Repository context: 1 file sent.',
        '> ℹ️ Rest of the pull request: 2 other changed files sent as context, 1 left out (over `review.prContextTokens`).',
        '> ℹ️ Open findings re-checked: 3.',
      ].join('\n>\n'),
    );
    expect(renderContextNote(disclosure, true)).toBe(
      [
        '> ℹ️ سياق المستودع: الملفات المُرسلة 1.',
        '> ℹ️ باقي الـ PR كسياق: الملفات المتغيرة الأخرى المُرسلة 2، وغير المُرسلة 1 (تجاوزت `review.prContextTokens`).',
        '> ℹ️ ملاحظات مفتوحة أُعيد فحصها: 3.',
      ].join('\n>\n'),
    );
  });

  it('says when the open findings could not be re-checked', () => {
    const unchecked = contextDisclosureOf(undefined, [], { shown: [], unchecked: true });
    expect(renderContextNote(unchecked, false)).toBe('> ℹ️ Open findings were not re-checked: their thread status could not be read.');
    expect(renderContextNote(unchecked, true)).toBe('> ℹ️ لم يُعَد فحص الملاحظات المفتوحة: تعذّرت قراءة حالة المحادثات.');
  });

  it('merges the bots of a panel: a PR file any bot sent is sent, open findings are united', () => {
    const merged = mergeContextDisclosures([
      { sent: [], leftOut: [], pr: { sent: ['a.ts'], leftOut: ['b.ts'] }, openFindings: { shown: ['41'] } },
      { sent: [], leftOut: [], pr: { sent: ['b.ts'], leftOut: ['c.ts'] }, openFindings: { shown: ['41', '42'], unchecked: false } },
      { sent: [], leftOut: [], openFindings: { shown: [], unchecked: true } },
    ]);
    expect(merged).toEqual({
      sent: [],
      leftOut: [],
      pr: { sent: ['a.ts', 'b.ts'], leftOut: ['c.ts'] },
      openFindings: { shown: ['41', '42'], unchecked: true },
    });
    expect(renderContextNote(merged, false)).toContain('Open findings re-checked: 2, but some bots could not read their thread status.');
  });
});

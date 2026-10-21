import { describe, expect, it } from 'vitest';
import { mergeContextDisclosures, renderContextNote } from './review-notes.js';

// ADR-0041: the summary names the files the review got by citation or reference, and a panel's
// bots keep their own.

describe('repository context note with cited files (ADR-0041)', () => {
  it('names the cited files in English and in Arabic', () => {
    const context = {
      sent: ['src/a.ts', 'docs/a.md', 'docs/b.md', 'src/c.ts'],
      leftOut: ['src/d.ts'],
      cited: ['docs/a.md', 'docs/b.md', 'src/c.ts'],
    };
    expect(renderContextNote(context, false)).toBe(
      '> ℹ️ Repository context: 4 files sent (3 cited by the change or the PR description: `docs/a.md`, `docs/b.md`, `src/c.ts`), 1 left out (over `review.contextTokens` or the read limit).',
    );
    expect(renderContextNote(context, true)).toBe(
      '> ℹ️ سياق المستودع: الملفات المُرسلة 4 (منها 3 مذكورة في التغييرات أو وصف الـ PR: `docs/a.md`، `docs/b.md`، `src/c.ts`)، وغير المُرسلة 1 (تجاوزت `review.contextTokens` أو حد القراءة).',
    );
  });

  it('names at most five cited files and counts the rest', () => {
    const cited = ['a.md', 'b.md', 'c.ts', 'd.md', 'e.md', 'f.md', 'g.md'];
    const context = { sent: cited, leftOut: [], cited };
    expect(renderContextNote(context, false)).toBe(
      '> ℹ️ Repository context: 7 files sent (7 cited by the change or the PR description: `a.md`, `b.md`, `c.ts`, `d.md`, `e.md` +2 more).',
    );
    expect(renderContextNote(context, true)).toBe(
      '> ℹ️ سياق المستودع: الملفات المُرسلة 7 (منها 7 مذكورة في التغييرات أو وصف الـ PR: `a.md`، `b.md`، `c.ts`، `d.md`، `e.md` و 2 غيرها).',
    );
  });

  it('leaves the line as it was when no file came by citation', () => {
    expect(renderContextNote({ sent: ['a.ts'], leftOut: [] }, false)).toBe(
      '> ℹ️ Repository context: 1 file sent.',
    );
    expect(renderContextNote({ sent: ['a.ts'], leftOut: [] }, true)).toBe(
      '> ℹ️ سياق المستودع: الملفات المُرسلة 1.',
    );
  });

  it('neutralizes a cited path that comes from a directory listing the author controls', () => {
    const path = 'docs/specs/012-<!-- mergepilot:x -->/spec.md';
    const context = { sent: [path], leftOut: [], cited: [path] };
    const note = renderContextNote(context, false) ?? '';

    expect(note).toContain('&lt;!--');
    expect(note).not.toContain('<!--');
  });

  it('merges the cited files of the panel bots and drops one no bot sent', () => {
    const merged = mergeContextDisclosures([
      { sent: ['a.md'], leftOut: [], cited: ['a.md'] },
      { sent: ['b.md'], leftOut: [], cited: ['b.md', 'c.md'] },
      undefined,
    ]);
    expect(merged?.cited).toEqual(['a.md', 'b.md']);
    expect(mergeContextDisclosures([{ sent: ['a.md'], leftOut: [], cited: ['a.md'] }])?.cited).toEqual(['a.md']);
  });
});

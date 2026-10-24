import { describe, expect, it } from 'vitest';
import { parsePatch } from '../diff/parse-patch.js';
import { estimateTokens } from './budget.js';
import { LINE_CUT_MARKER, splitPatchIntoParts } from './patch-parts.js';
import { buildReviewPrompt } from './prompt.js';

/** The body lines of a part: every line but the hunk headers. */
function bodyOf(part: string): string[] {
  return part.split('\n').filter((line) => !line.startsWith('@@'));
}

/** The line numbers of every part together. */
function linesOf(parts: string[]): { right: Set<number>; left: Set<number> } {
  const right = new Set<number>();
  const left = new Set<number>();
  for (const part of parts) {
    const parsed = parsePatch(part);
    for (const line of parsed.rightLines) right.add(line);
    for (const line of parsed.leftLines) left.add(line);
  }
  return { right, left };
}

describe('splitPatchIntoParts (ADR-0045)', () => {
  it('returns a patch that fits the cap whole', () => {
    const patch = '@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2';
    expect(splitPatchIntoParts(patch, 1000)).toEqual({ parts: [patch], cutLines: 0 });
  });

  it('packs whole hunks into parts of at most the cap', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      ' a',
      '@@ -10,1 +10,1 @@',
      ' b',
      '@@ -20,1 +20,1 @@',
      ' c',
    ].join('\n');
    const { parts } = splitPatchIntoParts(patch, 10);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(estimateTokens(part)).toBeLessThanOrEqual(10);
    }
    // Every hunk is in one part, in the order of the patch.
    expect(parts.flatMap((part) => parsePatch(part).hunks).map((hunk) => hunk.newStart)).toEqual([1, 10, 20]);
  });

  it('splits one huge added hunk into sub-hunks whose new-side numbers continue', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `+const v${i} = ${i};`);
    const patch = [`@@ -0,0 +1,300 @@`, ...lines].join('\n');
    const { parts } = splitPatchIntoParts(patch, 500);

    expect(parts.length).toBeGreaterThan(1);
    const headers = parts.map((part) => parsePatch(part).hunks[0]!);
    let next = 1;
    for (const header of headers) {
      expect(header.newStart).toBe(next);
      // The old side of a new file stays empty.
      expect(header.oldLines).toBe(0);
      expect(header.oldStart).toBe(0);
      next += header.newLines;
    }
    expect(next - 1).toBe(300);

    // The parts together cover the whole file.
    const { right } = linesOf(parts);
    expect(right.size).toBe(300);
    expect(Math.min(...right)).toBe(1);
    expect(Math.max(...right)).toBe(300);
  });

  it('splits a modified hunk with the right old and new starts and counts', () => {
    const patch = ['@@ -10,3 +10,4 @@', ' context1', '-old1', '+new1', '+new2', ' context2'].join('\n');
    // A cap of one token leaves every line in a sub-hunk of its own.
    const { parts } = splitPatchIntoParts(patch, 1);

    expect(parts).toEqual([
      '@@ -10,1 +10,1 @@\n context1',
      '@@ -11,1 +10,0 @@\n-old1',
      '@@ -11,0 +11,1 @@\n+new1',
      '@@ -11,0 +12,1 @@\n+new2',
      '@@ -12,1 +13,1 @@\n context2',
    ]);

    // The parts together say the same as the whole hunk.
    const whole = parsePatch(patch);
    const parts2 = linesOf(parts);
    expect(parts2.right).toEqual(whole.rightLines);
    expect(parts2.left).toEqual(whole.leftLines);
  });

  it('keeps a no-newline marker with the line it belongs to', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '\\ No newline at end of file',
      '+new',
      ' keep2',
    ].join('\n');
    const { parts } = splitPatchIntoParts(patch, 1);

    const withMarker = parts.find((part) => part.includes('\\ No newline at end of file'))!;
    const markerLines = withMarker.split('\n');
    expect(markerLines[markerLines.length - 1]).toBe('\\ No newline at end of file');
    expect(markerLines[markerLines.length - 2]).toBe('-old');
  });

  it('keeps the body lines of the parts exactly the body lines of the patch', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '+new2',
      ' keep2',
      '@@ -20,2 +20,1 @@',
      ' more',
      '-less',
    ].join('\n');
    const { parts } = splitPatchIntoParts(patch, 1);

    expect(parts.flatMap(bodyOf)).toEqual(bodyOf(patch));
  });

  it('cuts a line too big for the cap and counts it', () => {
    // A minified file on one line: the line alone is far over the cap.
    const patch = ['@@ -0,0 +1,2 @@', `+${'x'.repeat(500_000)}`, '+small'].join('\n');
    const { parts, cutLines } = splitPatchIntoParts(patch, 500);

    expect(cutLines).toBe(1);
    const cut = parts.find((part) => part.includes(LINE_CUT_MARKER))!;
    expect(cut).toBeDefined();
    // The part stays about the cap.
    expect(estimateTokens(cut)).toBeLessThanOrEqual(500);
    // The line keeps its prefix and says it was cut.
    const cutLine = cut.split('\n').find((line) => line.includes(LINE_CUT_MARKER))!;
    expect(cutLine.startsWith('+')).toBe(true);
    expect(cutLine.endsWith(LINE_CUT_MARKER)).toBe(true);
    // The line keeps its number: it is still the first line of the file.
    expect([...parsePatch(cut).addedLines]).toContain(1);
  });

  it('cuts a removed line too big for the cap, keeping its prefix', () => {
    const patch = ['@@ -1,2 +1,1 @@', `-${'y'.repeat(500_000)}`, ' keep'].join('\n');
    const { parts, cutLines } = splitPatchIntoParts(patch, 500);

    expect(cutLines).toBe(1);
    const cut = parts.find((part) => part.includes(LINE_CUT_MARKER))!;
    const cutLine = cut.split('\n').find((line) => line.includes(LINE_CUT_MARKER))!;
    expect(cutLine.startsWith('-')).toBe(true);
    expect(cutLine.endsWith(LINE_CUT_MARKER)).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(500);
  });
});

describe('the prompt of a part (ADR-0045)', () => {
  const input = {
    language: 'en',
    maxFindings: 5,
    pr: { title: 'T', body: '' },
    rulesFiles: [],
    pathInstructions: [],
  };

  it('names the part and says the other parts are reviewed elsewhere', () => {
    const { user } = buildReviewPrompt({
      ...input,
      files: [{ path: 'src/a.ts', patch: '@@ -1,1 +1,1 @@\n+const x = 1;', part: { index: 2, total: 3 } }],
    });

    expect(user).toContain('### src/a.ts (part 2 of 3)');
    expect(user).toContain("This is part 2 of 3 of this file's diff; the other parts are reviewed in other batches.");
    // The block label stays the path, so the line mapping of a finding does not change.
    expect(user).toContain('<<<UNTRUSTED:PATCH:src/a.ts>>>');
  });

  it('leaves a file that was not split as it was', () => {
    const { user } = buildReviewPrompt({
      ...input,
      files: [{ path: 'src/a.ts', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }],
    });

    expect(user).toContain('### src/a.ts\n');
    expect(user).not.toContain('(part ');
    expect(user).not.toContain('reviewed in other batches');
  });
});

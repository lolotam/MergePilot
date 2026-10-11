import { describe, expect, it } from 'vitest';
import { parsePatch } from './parse-patch.js';

describe('parsePatch', () => {
  it('parses a single hunk patch with context, additions, and removals', () => {
    const patch = [
      '@@ -10,3 +10,4 @@',
      ' context 1',
      '-removed line',
      '+added line 1',
      '+added line 2',
      ' context 2',
    ].join('\n');

    const result = parsePatch(patch);

    expect(result.hunks).toEqual([
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 },
    ]);
    expect(result.leftLines).toEqual(new Set([10, 11, 12]));
    expect(result.rightLines).toEqual(new Set([10, 11, 12, 13]));
    expect(result.addedLines).toEqual(new Set([11, 12]));
  });

  it('multi-hunk patch gives exact line sets', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' a',
      '+b',
      ' c',
      ' d',
      '@@ -10,3 +11,3 @@',
      ' x',
      '-y',
      '+z',
      ' w',
    ].join('\n');

    const result = parsePatch(patch);

    expect(result.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
      { oldStart: 10, oldLines: 3, newStart: 11, newLines: 3 },
    ]);
    expect(result.leftLines).toEqual(new Set([1, 2, 3, 10, 11, 12]));
    expect(result.rightLines).toEqual(new Set([1, 2, 3, 4, 11, 12, 13]));
    expect(result.addedLines).toEqual(new Set([2, 12]));
  });

  it('no-newline marker ignored', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' foo',
      '-bar',
      '\\ No newline at end of file',
      '+baz',
      '\\ No newline at end of file',
    ].join('\n');

    const result = parsePatch(patch);

    expect(result.hunks).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 },
    ]);
    expect(result.leftLines).toEqual(new Set([1, 2]));
    expect(result.rightLines).toEqual(new Set([1, 2]));
    expect(result.addedLines).toEqual(new Set([2]));
  });

  it('header without counts defaults line counts to 1', () => {
    const patch = [
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    const result = parsePatch(patch);

    expect(result.hunks).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
    ]);
    expect(result.leftLines).toEqual(new Set([1]));
    expect(result.rightLines).toEqual(new Set([1]));
    expect(result.addedLines).toEqual(new Set([1]));
  });

  it('header with partial counts handles omitted newLines or oldLines', () => {
    const patch1 = [
      '@@ -5 +5,2 @@',
      '-old',
      '+new1',
      '+new2',
    ].join('\n');

    const result1 = parsePatch(patch1);
    expect(result1.hunks).toEqual([
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 },
    ]);
    expect(result1.leftLines).toEqual(new Set([5]));
    expect(result1.rightLines).toEqual(new Set([5, 6]));
    expect(result1.addedLines).toEqual(new Set([5, 6]));

    const patch2 = [
      '@@ -5,2 +5 @@',
      '-old1',
      '-old2',
      '+new1',
    ].join('\n');

    const result2 = parsePatch(patch2);
    expect(result2.hunks).toEqual([
      { oldStart: 5, oldLines: 2, newStart: 5, newLines: 1 },
    ]);
    expect(result2.leftLines).toEqual(new Set([5, 6]));
    expect(result2.rightLines).toEqual(new Set([5]));
    expect(result2.addedLines).toEqual(new Set([5]));
  });

  it('handles empty patch and non-hunk strings gracefully', () => {
    const emptyResult = parsePatch('');
    expect(emptyResult.hunks).toEqual([]);
    expect(emptyResult.leftLines).toEqual(new Set());
    expect(emptyResult.rightLines).toEqual(new Set());
    expect(emptyResult.addedLines).toEqual(new Set());

    const whitespaceResult = parsePatch('   \n  \n');
    expect(whitespaceResult.hunks).toEqual([]);
    expect(whitespaceResult.leftLines).toEqual(new Set());
  });

  it('handles newly created and deleted files', () => {
    const createdPatch = [
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
    ].join('\n');

    const createdResult = parsePatch(createdPatch);
    expect(createdResult.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 },
    ]);
    expect(createdResult.leftLines).toEqual(new Set());
    expect(createdResult.rightLines).toEqual(new Set([1, 2]));
    expect(createdResult.addedLines).toEqual(new Set([1, 2]));

    const deletedPatch = [
      '@@ -1,2 +0,0 @@',
      '-first',
      '-second',
    ].join('\n');

    const deletedResult = parsePatch(deletedPatch);
    expect(deletedResult.hunks).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 },
    ]);
    expect(deletedResult.leftLines).toEqual(new Set([1, 2]));
    expect(deletedResult.rightLines).toEqual(new Set());
    expect(deletedResult.addedLines).toEqual(new Set());
  });
});

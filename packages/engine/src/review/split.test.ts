import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import {
  batchFilesBySize,
  batchFilesByTokenCap,
  dedupeFindings,
  PATCH_TRUNCATED_NOTE,
  truncatePatch,
} from './split.js';
import type { Finding } from './types.js';

describe('split - batchFilesBySize', () => {
  it('returns single batch when there is only one file', () => {
    const files = [{ path: 'src/a.ts', patch: '+line1\n+line2' }];
    const batches = batchFilesBySize(files);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(files);
  });

  it('splits two files into two batches', () => {
    const files = [
      { path: 'src/a.ts', patch: '+a1\n+a2' },
      { path: 'src/b.ts', patch: '+b1\n+b2' },
    ];
    const batches = batchFilesBySize(files);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([files[0]]);
    expect(batches[1]).toEqual([files[1]]);
  });

  it('splits multiple files by token size', () => {
    const files = [
      { path: 'src/a.ts', patch: '+small\n' },
      { path: 'src/b.ts', patch: '+large\n'.repeat(100) },
      { path: 'src/c.ts', patch: '+large\n'.repeat(100) },
    ];
    const batches = batchFilesBySize(files, 50);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const flattened = batches.flat();
    expect(flattened.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });
});

describe('split - dedupeFindings', () => {
  const makeFinding = (overrides: Partial<Finding>): Finding => ({
    id: 'f1',
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Bug',
    body: 'Details',
    severity: 'high',
    category: 'correctness',
    evidence: 'proof',
    confidence: 0.9,
    ...overrides,
  });

  it('deduplicates findings by path, line, and title (case-insensitive)', () => {
    const f1 = makeFinding({ path: 'src/a.ts', line: 10, title: 'Null dereference' });
    const f2 = makeFinding({ path: 'src/a.ts', line: 10, title: 'null dereference ' });
    const f3 = makeFinding({ path: 'src/a.ts', line: 11, title: 'Null dereference' });
    const f4 = makeFinding({ path: 'src/b.ts', line: 10, title: 'Null dereference' });

    const deduped = dedupeFindings([f1, f2, f3, f4]);
    expect(deduped).toHaveLength(3);
    expect(deduped[0]?.id).toBe('f1');
    expect(deduped[1]?.id).toBe('f2');
    expect(deduped[2]?.id).toBe('f3');
  });
});

describe('split - batchFilesByTokenCap (ADR-0013)', () => {
  const lines = (prefix: string, count: number): string =>
    Array.from({ length: count }, (_, i) => `+${prefix} line ${i}`).join('\n');

  it('fills batches up to the cap instead of splitting in halves', () => {
    // 10 files of ~100 tokens each, cap 300 → 4 batches (3+3+3+1), never 2 halves.
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts`, patch: 'x'.repeat(350) }));
    const { batches, truncatedPaths } = batchFilesByTokenCap(files, 300);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 3, 1]);
    for (const batch of batches) {
      expect(batch.reduce((sum, f) => sum + estimateTokens(f.patch), 0)).toBeLessThanOrEqual(300);
    }
    expect(batches.flat().map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(truncatedPaths).toEqual([]);
  });

  it('keeps a small PR in one batch', () => {
    const files = [
      { path: 'a.ts', patch: '+a' },
      { path: 'b.ts', patch: '+b' },
    ];
    expect(batchFilesByTokenCap(files, 1000).batches).toHaveLength(1);
  });

  it('puts a file bigger than the cap in its own batch, its patch truncated with a note', () => {
    const huge = lines('huge', 2000);
    const files = [
      { path: 'src/small.ts', patch: lines('s', 3) },
      { path: 'src/huge.ts', patch: huge },
      { path: 'src/after.ts', patch: lines('t', 3) },
    ];
    const { batches, truncatedPaths } = batchFilesByTokenCap(files, 500);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['src/small.ts'], ['src/huge.ts'], ['src/after.ts']]);
    expect(truncatedPaths).toEqual(['src/huge.ts']);
    const cut = batches[1]![0]!.patch;
    expect(cut.endsWith(`\n${PATCH_TRUNCATED_NOTE}`)).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(500);
    expect(huge.startsWith(cut.slice(0, cut.length - PATCH_TRUNCATED_NOTE.length - 1))).toBe(true);
  });

  it('truncatePatch cuts at a line break', () => {
    const cut = truncatePatch('+aaaa\n+bbbb\n+cccc', 30);
    expect(cut.split('\n').slice(0, -1).every((line) => /^\+[abc]{4}$/.test(line))).toBe(true);
  });
});


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

  // ~`tokens` estimated diff tokens (3.5 characters per token).
  const sized = (path: string, tokens: number) => ({ path, patch: 'x'.repeat(tokens * 3.5) });
  const pathsOf = (batches: Array<Array<{ path: string }>>) => batches.map((b) => b.map((f) => f.path));

  it('keeps an implementation and its test in one batch even when another file sits between them (ADR-0031)', () => {
    const files = [sized('src/parser.ts', 100), sized('src/lexer.ts', 200), sized('src/parser.test.ts', 100)];
    expect(pathsOf(batchFilesByTokenCap(files, 300).batches)).toEqual([['src/parser.ts', 'src/parser.test.ts'], ['src/lexer.ts']]);
  });

  it('keeps the files of one directory together across a file of another directory', () => {
    const files = [sized('src/a/one.ts', 100), sized('src/b/two.ts', 100), sized('src/a/three.ts', 100)];
    expect(pathsOf(batchFilesByTokenCap(files, 200).batches)).toEqual([['src/a/one.ts', 'src/a/three.ts'], ['src/b/two.ts']]);
  });

  it('splits a group bigger than the cap between its files without truncating them', () => {
    const files = [sized('src/x.ts', 200), sized('src/x.test.ts', 200)];
    const { batches, truncatedPaths } = batchFilesByTokenCap(files, 300);
    expect(pathsOf(batches)).toEqual([['src/x.ts'], ['src/x.test.ts']]);
    expect(truncatedPaths).toEqual([]);
  });

  it('in a mixed directory split over the cap, schedules source units before test-only units', () => {
    const files = [sized('src/a.test.ts', 100), sized('src/b.ts', 100)];
    expect(pathsOf(batchFilesByTokenCap(files, 100).batches)).toEqual([['src/b.ts'], ['src/a.test.ts']]);
  });

  it("places every directory's source before the tests split out of an oversized source group", () => {
    const files = [sized('src/a/main.ts', 100), sized('src/a/orphan.test.ts', 100), sized('src/b/main.ts', 100)];
    expect(pathsOf(batchFilesByTokenCap(files, 100).batches)).toEqual([['src/a/main.ts'], ['src/b/main.ts'], ['src/a/orphan.test.ts']]);
  });

  it('orders source, then tests, then config and CI, then docs', () => {
    const files = [
      sized('README.md', 100),
      sized('.github/workflows/ci.yml', 100),
      sized('package.json', 100),
      sized('tests/helpers.test.ts', 100),
      sized('src/y.ts', 100),
    ];
    expect(pathsOf(batchFilesByTokenCap(files, 100).batches)).toEqual([
      ['src/y.ts'],
      ['tests/helpers.test.ts'],
      ['.github/workflows/ci.yml'],
      ['package.json'],
      ['README.md'],
    ]);
  });

  it('truncatePatch cuts at a line break', () => {
    const cut = truncatePatch('+aaaa\n+bbbb\n+cccc', 30);
    expect(cut.split('\n').slice(0, -1).every((line) => /^\+[abc]{4}$/.test(line))).toBe(true);
  });
});


import { describe, expect, it } from 'vitest';
import { batchFilesBySize, dedupeFindings } from './split.js';
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

import { describe, expect, it } from 'vitest';
import type { Finding } from '../review/types.js';
import type { ParsedPatch } from '../diff/parse-patch.js';
import { anchorFindings } from './anchor.js';

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f1',
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Test issue',
    body: 'Test details',
    severity: 'high',
    category: 'correctness',
    evidence: 'const x = 1;',
    confidence: 0.9,
    ...overrides,
  };
}

describe('anchorFindings', () => {
  const index = new Map<string, ParsedPatch>([
    [
      'src/a.ts',
      {
        hunks: [{ oldStart: 5, oldLines: 3, newStart: 5, newLines: 4 }],
        leftLines: new Set([5, 6, 7]),
        rightLines: new Set([5, 6, 7, 8]),
        addedLines: new Set([8]),
      },
    ],
  ]);

  it('anchors RIGHT-side finding inline when line is in rightLines', () => {
    const f = makeFinding({ path: 'src/a.ts', line: 7, side: 'RIGHT' });
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([f]);
    expect(result.summaryOnly).toEqual([]);
  });

  it('anchors LEFT-side finding inline when line is in leftLines', () => {
    const f = makeFinding({ path: 'src/a.ts', line: 6, side: 'LEFT' });
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([f]);
    expect(result.summaryOnly).toEqual([]);
  });

  it('puts finding on an unchanged line into summaryOnly', () => {
    // line 50 is outside the hunk
    const f = makeFinding({ path: 'src/a.ts', line: 50, side: 'RIGHT' });
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([f]);
  });

  it('puts finding for unknown path into summaryOnly', () => {
    const f = makeFinding({ path: 'src/other.ts', line: 5, side: 'RIGHT' });
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([f]);
  });

  it('puts LEFT-side finding on right-only line into summaryOnly', () => {
    // line 8 is only in rightLines, not leftLines
    const f = makeFinding({ path: 'src/a.ts', line: 8, side: 'LEFT' });
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([f]);
  });

  it('puts RIGHT-side finding on left-only line into summaryOnly', () => {
    const customIndex = new Map<string, ParsedPatch>([
      [
        'src/b.ts',
        {
          hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1 }],
          leftLines: new Set([1, 2]),
          rightLines: new Set([1]),
          addedLines: new Set(),
        },
      ],
    ]);

    const f = makeFinding({ path: 'src/b.ts', line: 2, side: 'RIGHT' });
    const result = anchorFindings([f], customIndex);

    expect(result.inline).toEqual([]);
    expect(result.summaryOnly).toEqual([f]);
  });

  it('defaults undefined side to RIGHT', () => {
    const f = {
      ...makeFinding({ path: 'src/a.ts', line: 7 }),
      side: undefined as unknown as 'RIGHT',
    };
    const result = anchorFindings([f], index);

    expect(result.inline).toEqual([f]);
    expect(result.summaryOnly).toEqual([]);
  });
});

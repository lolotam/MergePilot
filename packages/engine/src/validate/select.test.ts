import { describe, expect, it } from 'vitest';
import type { Finding } from '../review/types.js';
import { selectFindings } from './select.js';

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f1',
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT',
    title: 'Test finding',
    body: 'Details',
    severity: 'medium',
    category: 'correctness',
    evidence: 'test code',
    confidence: 0.8,
    ...overrides,
  };
}

describe('selectFindings', () => {
  it('filters findings below minSeverity', () => {
    const findings: Finding[] = [
      makeFinding({ id: '1', line: 1, severity: 'critical' }),
      makeFinding({ id: '2', line: 2, severity: 'high' }),
      makeFinding({ id: '3', line: 3, severity: 'medium' }),
      makeFinding({ id: '4', line: 4, severity: 'low' }),
      makeFinding({ id: '5', line: 5, severity: 'info' }),
    ];

    const result = selectFindings(findings, { minSeverity: 'medium' });
    const severities = result.map((f) => f.severity);

    expect(severities).toEqual(['critical', 'high', 'medium']);
  });

  it('keeps all findings when minSeverity is not specified', () => {
    const findings: Finding[] = [
      makeFinding({ id: '1', line: 1, severity: 'critical' }),
      makeFinding({ id: '2', line: 2, severity: 'info' }),
    ];

    const result = selectFindings(findings, {});
    expect(result).toHaveLength(2);
  });

  it('dedupes same path + line + normalized title keeping higher severity', () => {
    const f1 = makeFinding({
      id: 'f1',
      path: 'src/a.ts',
      line: 15,
      title: '  Potential   SQL Injection  ',
      severity: 'medium',
      confidence: 0.9,
    });
    const f2 = makeFinding({
      id: 'f2',
      path: 'src/a.ts',
      line: 15,
      title: 'potential sql injection',
      severity: 'critical',
      confidence: 0.7,
    });

    const result = selectFindings([f1, f2], {});
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('f2');
    expect(result[0]?.severity).toBe('critical');
  });

  it('dedupes keeping higher confidence when severity is identical', () => {
    const f1 = makeFinding({
      id: 'f1',
      path: 'src/a.ts',
      line: 15,
      title: 'Missing check',
      severity: 'high',
      confidence: 0.75,
    });
    const f2 = makeFinding({
      id: 'f2',
      path: 'src/a.ts',
      line: 15,
      title: 'missing check',
      severity: 'high',
      confidence: 0.95,
    });

    const result = selectFindings([f1, f2], {});
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('f2');
    expect(result[0]?.confidence).toBe(0.95);
  });

  it('breaks ties deterministically when severity and confidence are identical', () => {
    const fA = makeFinding({
      id: 'fA',
      path: 'src/a.ts',
      line: 15,
      title: 'Same issue',
      severity: 'high',
      confidence: 0.8,
    });
    const fB = makeFinding({
      id: 'fB',
      path: 'src/a.ts',
      line: 15,
      title: 'Same issue',
      severity: 'high',
      confidence: 0.8,
    });

    // Regardless of order in input, the chosen one is identical
    const result1 = selectFindings([fA, fB], {});
    const result2 = selectFindings([fB, fA], {});

    expect(result1[0]?.id).toBe(result2[0]?.id);
  });

  it('sorts by severity rank, then confidence desc, then path, then line', () => {
    const f1 = makeFinding({ id: '1', path: 'src/z.ts', line: 10, severity: 'low', confidence: 0.9 });
    const f2 = makeFinding({ id: '2', path: 'src/a.ts', line: 5, severity: 'critical', confidence: 0.8 });
    const f3 = makeFinding({ id: '3', path: 'src/b.ts', line: 20, severity: 'high', confidence: 0.95 });
    const f4 = makeFinding({ id: '4', path: 'src/b.ts', line: 10, severity: 'high', confidence: 0.95 });
    const f5 = makeFinding({ id: '5', path: 'src/b.ts', line: 5, severity: 'high', confidence: 0.7 });

    const result = selectFindings([f1, f2, f3, f4, f5], {});

    expect(result.map((f) => f.id)).toEqual([
      '2', // critical
      '4', // high, conf 0.95, path src/b.ts, line 10
      '3', // high, conf 0.95, path src/b.ts, line 20
      '5', // high, conf 0.7, path src/b.ts, line 5
      '1', // low
    ]);
  });

  it('caps at maxFindings', () => {
    const findings: Finding[] = [
      makeFinding({ id: '1', line: 1, severity: 'critical' }),
      makeFinding({ id: '2', line: 2, severity: 'high' }),
      makeFinding({ id: '3', line: 3, severity: 'medium' }),
      makeFinding({ id: '4', line: 4, severity: 'low' }),
    ];

    const result = selectFindings(findings, { maxFindings: 2 });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual(['1', '2']);
  });

  it('handles maxFindings of 0 and greater than count', () => {
    const findings: Finding[] = [
      makeFinding({ id: '1', line: 1, severity: 'critical' }),
      makeFinding({ id: '2', line: 2, severity: 'high' }),
    ];

    expect(selectFindings(findings, { maxFindings: 0 })).toEqual([]);
    expect(selectFindings(findings, { maxFindings: 10 })).toHaveLength(2);
  });

  it('is pure and does not mutate the input array', () => {
    const original: Finding[] = [
      makeFinding({ id: '2', line: 2, severity: 'low' }),
      makeFinding({ id: '1', line: 1, severity: 'critical' }),
    ];
    const originalCopy = [...original];

    selectFindings(original, { maxFindings: 1 });
    expect(original).toEqual(originalCopy);
  });

  it('keeps findings on the same line number but different diff sides', () => {
    const findings: Finding[] = [
      makeFinding({ id: 'left', side: 'LEFT' }),
      makeFinding({ id: 'right', side: 'RIGHT' }),
    ];

    expect(selectFindings(findings).map((f) => f.id).sort()).toEqual(['left', 'right']);
  });
});

import { describe, expect, it } from 'vitest';
import { FindingSchema, SEVERITY_RANK } from './types.js';

const valid = {
  id: 'f1',
  path: 'src/a.ts',
  line: 3,
  title: 'Null dereference',
  body: 'x can be undefined here.',
  severity: 'high',
  category: 'correctness',
  evidence: 'const y = x.value;',
  confidence: 0.8,
};

describe('FindingSchema', () => {
  it('accepts a complete finding and defaults side to RIGHT', () => {
    expect(FindingSchema.parse(valid).side).toBe('RIGHT');
  });

  it('rejects a finding without evidence', () => {
    expect(FindingSchema.safeParse({ ...valid, evidence: '' }).success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(FindingSchema.safeParse({ ...valid, confidence: 1.2 }).success).toBe(false);
  });
});

describe('SEVERITY_RANK', () => {
  it('orders critical before info', () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.info);
  });
});

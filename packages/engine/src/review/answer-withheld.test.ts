import { describe, expect, it } from 'vitest';
import { parseReviewAnswer } from './answer.js';
import { reviewJsonSchema } from './split.js';
import { MAX_WITHHELD_ITEMS, WITHHELD_REASON_MAX_CHARS, WITHHELD_TITLE_MAX_CHARS } from './withheld.js';

// ADR-0042: `withheld` is optional in the answer, and a bad one never drops the summary or the
// findings of an answer.

const FINDING = {
  path: 'src/foo.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Null dereference',
  body: 'Could throw if x is null.',
  severity: 'high',
  category: 'correctness',
  evidence: 'x.doSomething()',
  confidence: 0.9,
};

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ summary: 'Looks mostly fine.', findings: [FINDING], ...overrides });
}

describe('parseReviewAnswer — withheld (ADR-0042)', () => {
  it('parses an answer without withheld, with no withheld key', () => {
    const result = parseReviewAnswer(answer());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('withheld' in result).toBe(false);
      expect(result.findings).toHaveLength(1);
    }
  });

  it('keeps the valid withheld items', () => {
    const result = parseReviewAnswer(
      answer({
        withheld: [
          { title: 'Null deref', reason: 'below the confidence bar' },
          { title: 'Slow query', reason: 'out of scope' },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.withheld).toEqual([
        { title: 'Null deref', reason: 'below the confidence bar' },
        { title: 'Slow query', reason: 'out of scope' },
      ]);
    }
  });

  it('drops a bad withheld value and keeps the summary and every finding', () => {
    for (const bad of ['nope', [{ title: 'x' }], 42, null]) {
      const result = parseReviewAnswer(answer({ withheld: bad }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toBe('Looks mostly fine.');
        expect(result.findings).toHaveLength(1);
        // A list with only invalid items is an empty list; anything else is no list.
        expect(result.withheld).toEqual(Array.isArray(bad) ? [] : undefined);
      }
    }
  });

  it('keeps a list sent empty as an empty list, unlike an omitted one', () => {
    const result = parseReviewAnswer(answer({ withheld: [] }));

    expect(result.ok && result.withheld).toEqual([]);
  });

  it('keeps the withheld items of a summary-only answer', () => {
    const result = parseReviewAnswer(
      JSON.stringify({ summary: 'Nothing to report.', withheld: [{ title: 'A', reason: 'B' }] }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBe('Nothing to report.');
      expect(result.findings).toHaveLength(0);
      expect(result.withheld).toEqual([{ title: 'A', reason: 'B' }]);
    }
  });

  it('sends the withheld field in the JSON response schema, and does not require it', () => {
    const schema = reviewJsonSchema();
    const properties = schema['properties'] as Record<string, unknown> | undefined;
    const required = schema['required'] as string[] | undefined;

    expect(properties).toHaveProperty('withheld');
    expect(required ?? []).not.toContain('withheld');
    // Bounded, so the list fits the summary room of the answer budget.
    expect(properties?.['withheld']).toMatchObject({
      maxItems: MAX_WITHHELD_ITEMS,
      items: { properties: { title: { maxLength: WITHHELD_TITLE_MAX_CHARS }, reason: { maxLength: WITHHELD_REASON_MAX_CHARS } } },
    });
  });
});

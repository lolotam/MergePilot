import { describe, expect, it } from 'vitest';
import { renderReviewSummary, type ReviewSummaryInput } from './summary.js';

const baseInput: ReviewSummaryInput = {
  language: 'en',
  summary: 'The changes introduce security improvements to authentication.',
  summaryOnly: [],
  inlineCount: 2,
  complete: true,
  incompleteReasons: [],
  modelLabel: 'anthropic:claude-sonnet-5-5',
  outcome: 'completed',
};

describe('renderReviewSummary — withheld problems (ADR-0042)', () => {
  const withheld = [
    { title: 'Null deref', reason: 'below the confidence bar' },
    { title: 'Slow query', reason: 'out of scope' },
  ];

  it('lists what the model noticed and did not report, folded, in English', () => {
    const rendered = renderReviewSummary({ ...baseInput, withheld });

    expect(rendered).toContain('<summary>Noticed but not reported (2)</summary>');
    expect(rendered).toContain('- Null deref — below the confidence bar');
    expect(rendered).toContain('- Slow query — out of scope');
  });

  it('lists them in Arabic too', () => {
    const rendered = renderReviewSummary({ ...baseInput, language: 'ar', withheld });

    expect(rendered).toContain('<summary>رصدها ولم ينشرها كملاحظات (2)</summary>');
    expect(rendered).toContain('- Null deref — below the confidence bar');
    expect(rendered).toContain('- Slow query — out of scope');
  });

  it('says nothing when the model withheld nothing', () => {
    expect(renderReviewSummary(baseInput)).not.toContain('Noticed but not reported');
    expect(renderReviewSummary({ ...baseInput, language: 'ar' })).not.toContain('رصدها ولم ينشرها');
  });
});

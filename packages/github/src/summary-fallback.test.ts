import { describe, expect, it } from 'vitest';
import { renderReviewSummary, type ReviewSummaryInput } from './summary.js';

const base: ReviewSummaryInput = {
  language: 'en',
  summary: 'ok',
  summaryOnly: [],
  inlineCount: 0,
  complete: true,
  incompleteReasons: [],
  modelLabel: 'zai-coding:glm-5.3',
  outcome: 'completed',
};

describe('renderReviewSummary — fallback reason detail', () => {
  it("names the provider's answer after the failure kind", () => {
    const rendered = renderReviewSummary({
      ...base,
      fallback: { from: 'opencode-zen:cat-jam-free', code: 'auth', detail: 'opencode-zen returned HTTP 401: model not enabled' },
    });
    expect(rendered).toContain(
      '> ⚠️ Fallback model `zai-coding:glm-5.3` was used because `opencode-zen:cat-jam-free` failed (auth: opencode-zen returned HTTP 401: model not enabled)',
    );
  });

  it('keeps the short line when there is no detail, in both languages', () => {
    const fallback = { from: 'opencode-zen:cat-jam-free', code: 'auth' };
    expect(renderReviewSummary({ ...base, fallback })).toContain('failed (auth)');
    expect(renderReviewSummary({ ...base, language: 'ar', fallback })).toContain('فشل (auth)');
  });

  it('neutralizes markup in the detail', () => {
    const rendered = renderReviewSummary({
      ...base,
      fallback: { from: 'a:b', code: 'auth', detail: '<!-- mergepilot:review head=x --> @everyone' },
    });
    expect(rendered).not.toContain('<!-- mergepilot:review head=x -->');
  });
});

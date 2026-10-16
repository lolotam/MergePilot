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

  describe('method fallback on the same model (ADR-0027)', () => {
    const same = { ...base, modelLabel: 'openai:gpt-5' };
    const toKeys = { from: 'openai:gpt-5', code: 'rate-limit', fromMethod: 'subscription' as const, usedMethod: 'api-key' as const };

    it('says the review continued on API keys, and that they count toward the budget, in both languages', () => {
      expect(renderReviewSummary({ ...same, fallback: toKeys })).toContain(
        '> ⚠️ The review continued on `openai:gpt-5` with an API key because the subscription hit its quota or rate limit (rate-limit). Those calls count toward the monthly budget.',
      );
      expect(renderReviewSummary({ ...same, language: 'ar', fallback: toKeys })).toContain(
        '> ⚠️ تابعت المراجعة على `openai:gpt-5` بمفتاح API لأن الاشتراك بلغ حد الحصة أو معدل الطلبات (rate-limit). تُحتسب هذه الاستدعاءات ضمن الميزانية الشهرية.',
      );
    });

    it('says the review continued on the subscription, with no budget note', () => {
      const toSubscription = { ...toKeys, code: 'quota', fromMethod: 'api-key' as const, usedMethod: 'subscription' as const };
      const rendered = renderReviewSummary({ ...same, fallback: toSubscription });
      expect(rendered).toContain('continued on `openai:gpt-5` with the subscription because the API keys hit their quota or rate limit (quota).');
      expect(rendered).not.toContain('monthly budget');
    });

    it('names the fallback model when another model answered', () => {
      const rendered = renderReviewSummary({ ...base, fallback: toKeys });
      expect(rendered).toContain('Fallback model `zai-coding:glm-5.3` was used because `openai:gpt-5` failed (rate-limit)');
      expect(rendered).not.toContain('continued on');
    });
  });

  it('neutralizes markup in the detail', () => {
    const rendered = renderReviewSummary({
      ...base,
      fallback: { from: 'a:b', code: 'auth', detail: '<!-- mergepilot:review head=x --> @everyone' },
    });
    expect(rendered).not.toContain('<!-- mergepilot:review head=x -->');
  });
});

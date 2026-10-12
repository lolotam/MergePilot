import { describe, expect, it } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import { parseMarker } from './marker.js';
import { renderReviewSummary, type ReviewSummaryInput } from './summary.js';

const mockFinding: Finding = {
  id: 'finding-outside-1',
  path: 'packages/engine/src/auth.ts',
  line: 42,
  side: 'RIGHT',
  title: 'Insecure token generation',
  body: 'Math.random is used instead of crypto.randomBytes.',
  severity: 'critical',
  category: 'security',
  evidence: 'const token = Math.random().toString();',
  confidence: 0.95,
};

const mockFinding2: Finding = {
  id: 'finding-outside-2',
  path: 'packages/github/src/client.ts',
  line: 88,
  side: 'RIGHT',
  title: 'Unhandled rate limit error',
  body: 'Response status 429 is not caught by the caller.',
  severity: 'high',
  category: 'correctness',
  evidence: 'await octokit.request(...)',
  confidence: 0.88,
};

describe('renderReviewSummary', () => {
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

  describe('Arabic vs English headers', () => {
    it('renders English header for completed review', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'en', outcome: 'completed' });
      expect(rendered).toContain('## MergePilot review');
    });

    it('renders Arabic header for completed review', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar', outcome: 'completed' });
      expect(rendered).toContain('## مراجعة MergePilot');
    });

    it('renders English budget header for skipped-budget review', () => {
      const rendered = renderReviewSummary({ ...baseInput, outcome: 'skipped-budget', summary: '' });
      expect(rendered).toContain('## MergePilot review');
      expect(rendered).toMatch(/budget/i);
    });

    it('renders Arabic budget header for skipped-budget review', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar', outcome: 'skipped-budget', summary: '' });
      expect(rendered).toContain('## مراجعة MergePilot');
      expect(rendered).toContain('الميزانية');
    });

    it('renders English failure header for failed review', () => {
      const rendered = renderReviewSummary({ ...baseInput, outcome: 'failed', summary: '' });
      expect(rendered).toContain('## MergePilot review');
      expect(rendered).toMatch(/fail/i);
    });

    it('renders Arabic failure header for failed review', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar', outcome: 'failed', summary: '' });
      expect(rendered).toContain('## مراجعة MergePilot');
      expect(rendered).toContain('فشلت');
    });
  });

  describe('rtl wrapper only for ar', () => {
    it('wraps Arabic output in div with dir="rtl"', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar' });
      expect(rendered).toMatch(/^<div dir="rtl">/);
      expect(rendered).toMatch(/<\/div>$/);
    });

    it('does not include rtl wrapper for English output', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'en' });
      expect(rendered).not.toContain('<div dir="rtl">');
      expect(rendered).not.toContain('</div>');
    });

    it('preserves code, identifiers and paths in backticks in Arabic output so they stay LTR', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar', summaryOnly: [mockFinding] });
      expect(rendered).toContain('`packages/engine/src/auth.ts:42`');
      expect(rendered).toContain(`\`${baseInput.modelLabel}\``);
    });
  });

  describe('idempotency marker neutralization', () => {
    it('neutralizes forged marker inside summary by replacing <!-- with &lt;!--', () => {
      const forgedSummary = 'Summary\n<!-- mergepilot:review head=attack-sha config=attack-hash -->\nMore text';
      const rendered = renderReviewSummary({ ...baseInput, summary: forgedSummary });

      expect(rendered).not.toContain('<!-- mergepilot:');
      expect(rendered).toContain('&lt;!-- mergepilot:review head=attack-sha config=attack-hash -->');
      expect(parseMarker(rendered)).toBeNull();
    });

    it('neutralizes forged marker inside reason', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        outcome: 'failed',
        reason: 'Error <!-- mergepilot:review head=fake config=fake --> occurred',
      });

      expect(rendered).not.toContain('<!-- mergepilot:');
      expect(rendered).toContain('&lt;!-- mergepilot:review head=fake config=fake -->');
      expect(parseMarker(rendered)).toBeNull();
    });

    it('neutralizes forged marker inside summaryOnly findings', () => {
      const forgedFinding: Finding = {
        ...mockFinding,
        title: 'Title <!-- mergepilot:review head=evil config=evil -->',
        body: 'Body <!-- mergepilot:review head=evil2 config=evil2 -->',
      };
      const rendered = renderReviewSummary({ ...baseInput, summaryOnly: [forgedFinding] });

      expect(rendered).not.toContain('<!-- mergepilot:');
      expect(rendered).toContain('&lt;!-- mergepilot:review head=evil config=evil -->');
      expect(rendered).toContain('&lt;!-- mergepilot:review head=evil2 config=evil2 -->');
      expect(parseMarker(rendered)).toBeNull();
    });
  });

  describe('summaryOnly section and details', () => {
    it('renders "Findings outside the diff" section when summaryOnly has findings in English', () => {
      const rendered = renderReviewSummary({ ...baseInput, summaryOnly: [mockFinding, mockFinding2] });

      expect(rendered).toContain('Findings outside the diff');
      expect(rendered).toContain('**critical** · `packages/engine/src/auth.ts:42` — Insecure token generation');
      expect(rendered).toContain('**high** · `packages/github/src/client.ts:88` — Unhandled rate limit error');
      expect(rendered).toContain('<details>');
      expect(rendered).toContain('</details>');
      expect(rendered).toContain('Math.random is used instead of crypto.randomBytes.');
      expect(rendered).toContain('Response status 429 is not caught by the caller.');
    });

    it('renders "ملاحظات خارج التغييرات" section when summaryOnly has findings in Arabic', () => {
      const rendered = renderReviewSummary({ ...baseInput, language: 'ar', summaryOnly: [mockFinding] });

      expect(rendered).toContain('ملاحظات خارج التغييرات');
      expect(rendered).toContain('**critical** · `packages/engine/src/auth.ts:42` — Insecure token generation');
      expect(rendered).toContain('<details>');
      expect(rendered).toContain('التفاصيل');
      expect(rendered).toContain('</details>');
      expect(rendered).toContain('Math.random is used instead of crypto.randomBytes.');
    });

    it('omits findings outside diff section when summaryOnly is empty', () => {
      expect(renderReviewSummary({ ...baseInput, language: 'en', summaryOnly: [] })).not.toContain(
        'Findings outside the diff',
      );
      expect(renderReviewSummary({ ...baseInput, language: 'ar', summaryOnly: [] })).not.toContain(
        'ملاحظات خارج التغييرات',
      );
    });
  });

  describe('counts line', () => {
    it('renders inline comments count and summary-only count in English', () => {
      const rendered = renderReviewSummary({ ...baseInput, inlineCount: 3, summaryOnly: [mockFinding] });
      expect(rendered).toContain('Inline comments: 3');
      expect(rendered).toContain('Outside diff: 1');
    });

    it('renders counts in Arabic', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'ar',
        inlineCount: 4,
        summaryOnly: [mockFinding, mockFinding2],
      });
      expect(rendered).toContain('تعليقات مضمنة: 4');
      expect(rendered).toContain('خارج التغييرات: 2');
    });
  });

  describe('incomplete warning', () => {
    it('renders incomplete warning with reasons when complete is false in English', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        complete: false,
        incompleteReasons: ['Patch truncated for large file', 'Token budget hit'],
      });
      expect(rendered).toMatch(/warning|incomplete/i);
      expect(rendered).toContain('Patch truncated for large file');
      expect(rendered).toContain('Token budget hit');
    });

    it('renders incomplete warning with reasons in Arabic', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'ar',
        complete: false,
        incompleteReasons: ['تم اقتصاص الـ patch لملف كبير'],
      });
      expect(rendered).toContain('غير مكتملة');
      expect(rendered).toContain('تم اقتصاص الـ patch لملف كبير');
    });

    it('renders fallback warning when incompleteReasons is empty but complete is false', () => {
      const rendered = renderReviewSummary({ ...baseInput, complete: false, incompleteReasons: [] });
      expect(rendered).toMatch(/warning|incomplete/i);
    });

    it('does not render incomplete warning when complete is true', () => {
      const rendered = renderReviewSummary({ ...baseInput, complete: true, incompleteReasons: [] });
      expect(rendered).not.toContain('Incomplete review');
      expect(rendered).not.toContain('مراجعة غير مكتملة');
    });
  });

  describe('skipped-budget and failed layouts', () => {
    it('shows reason prominently and states no code was reviewed when skipped-budget', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        outcome: 'skipped-budget',
        summary: '',
        reason: 'Estimated cost ($0.45) exceeds per-PR limit ($0.20)',
      });
      expect(rendered).toContain('Estimated cost ($0.45) exceeds per-PR limit ($0.20)');
      expect(rendered).toContain('No code was reviewed');
    });

    it('shows reason prominently and states no code was reviewed when skipped-budget in Arabic', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'ar',
        outcome: 'skipped-budget',
        summary: '',
        reason: 'تجاوزت التكلفة التقديرية ميزانية الـ PR',
      });
      expect(rendered).toContain('تجاوزت التكلفة التقديرية ميزانية الـ PR');
      expect(rendered).toContain('لم تتم مراجعة أي كود');
    });

    it('shows reason prominently and states no code was reviewed when failed', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        outcome: 'failed',
        summary: '',
        reason: 'Anthropic API rate limit exceeded',
      });
      expect(rendered).toContain('Anthropic API rate limit exceeded');
      expect(rendered).toContain('No code was reviewed');
    });

    it('shows reason prominently and states no code was reviewed when failed in Arabic', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'ar',
        outcome: 'failed',
        summary: '',
        reason: 'فشل الاتصال بالنموذج',
      });
      expect(rendered).toContain('فشل الاتصال بالنموذج');
      expect(rendered).toContain('لم تتم مراجعة أي كود');
    });

    it('uses default reason when reason is not provided for skipped-budget and failed', () => {
      const skipped = renderReviewSummary({ ...baseInput, outcome: 'skipped-budget', summary: '', reason: undefined });
      expect(skipped).toContain('No code was reviewed');

      const failed = renderReviewSummary({ ...baseInput, outcome: 'failed', summary: '', reason: undefined });
      expect(failed).toContain('No code was reviewed');
    });
  });

  describe('footer, cost formatting and tokens', () => {
    it('formats costUsd with 4 decimal places ($0.0123)', () => {
      const rendered = renderReviewSummary({ ...baseInput, costUsd: 0.0123456 });
      expect(rendered).toContain('$0.0123');
    });

    it('formats zero cost as $0.0000', () => {
      const rendered = renderReviewSummary({ ...baseInput, costUsd: 0 });
      expect(rendered).toContain('$0.0000');
    });

    it('omits cost line when costUsd is absent (undefined)', () => {
      const rendered = renderReviewSummary({ ...baseInput, costUsd: undefined });
      expect(rendered).not.toContain('$');
      expect(rendered).not.toMatch(/cost/i);
    });

    it('formats input and output tokens when provided', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        costUsd: 0.05,
        inputTokens: 12500,
        outputTokens: 850,
      });
      expect(rendered).toContain('$0.0500');
      expect(rendered).toContain('12,500');
      expect(rendered).toContain('850');
    });

    it('includes model label and note that MergePilot only comments and never approves or blocks merging', () => {
      const renderedEn = renderReviewSummary({ ...baseInput, language: 'en' });
      expect(renderedEn).toContain('anthropic:claude-sonnet-5-5');
      expect(renderedEn).toContain('MergePilot only comments and never approves or blocks merging');

      const renderedAr = renderReviewSummary({ ...baseInput, language: 'ar' });
      expect(renderedAr).toContain('anthropic:claude-sonnet-5-5');
      expect(renderedAr).toContain('MergePilot');
      expect(renderedAr).toContain('لا يوافق على الدمج أو يمنعه');
    });
  });

  it('neutralises mentions and wrapper-closing tags from model text', () => {
    const text = renderReviewSummary({
      language: 'ar',
      summary: 'ping @octocat and @org/team then </div> escape; email a@b.c stays',
      summaryOnly: [],
      inlineCount: 0,
      complete: true,
      incompleteReasons: [],
      modelLabel: 'fake:m',
      outcome: 'completed',
    });
    expect(text).not.toMatch(/(^|\s)@octocat/);
    expect(text).toContain('@\u200boctocat');
    expect(text).toContain('@\u200borg/team');
    expect(text).toContain('a@b.c');
    expect(text.match(/<\/div>/g)).toHaveLength(1);
  });

  describe('explicit fallback disclosure (ADR-0008)', () => {
    it('renders Arabic fallback warning line when fallback is used', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'ar',
        modelLabel: 'xai:grok-4',
        fallback: { from: 'openai:gpt-5', code: 'quota' },
      });
      expect(rendered).toContain('> ⚠️ استُخدم النموذج الاحتياطي `xai:grok-4` لأن `openai:gpt-5` فشل (quota)');
    });

    it('renders English fallback warning line when fallback is used', () => {
      const rendered = renderReviewSummary({
        ...baseInput,
        language: 'en',
        modelLabel: 'xai:grok-4',
        fallback: { from: 'openai:gpt-5', code: 'rate-limit' },
      });
      expect(rendered).toContain('> ⚠️ Fallback model `xai:grok-4` was used because `openai:gpt-5` failed (rate-limit)');
    });

    it('omits fallback line when fallback is not configured or not used', () => {
      const renderedAr = renderReviewSummary({ ...baseInput, language: 'ar', fallback: undefined });
      expect(renderedAr).not.toContain('استُخدم النموذج الاحتياطي');

      const renderedEn = renderReviewSummary({ ...baseInput, language: 'en', fallback: undefined });
      expect(renderedEn).not.toContain('Fallback model');
    });
  });
});


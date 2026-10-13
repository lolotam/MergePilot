import { describe, expect, it, vi } from 'vitest';
import { JudgeUnavailableError, type Finding, type Judge, type JudgeRequest } from '@mergepilot/engine';
import type { GitHubClient, GitHubReviewComment } from './client.js';
import { deduplicateFindings } from './dedupe.js';
import { dedupeJudgeOf, judgeSummaryInput, withJudgeUsage, type ReviewJudge } from './judge-summary.js';
import { renderReviewSummary } from './summary.js';

const publisherLogin = 'github-actions[bot]';

function finding(id: string, line: number, title: string): Finding {
  return {
    id,
    path: 'src/main.ts',
    line,
    side: 'RIGHT',
    title,
    body: `${title} body`,
    severity: 'high',
    category: 'correctness',
    evidence: 'foo()',
    confidence: 0.9,
  };
}

const existing: GitHubReviewComment[] = [
  {
    id: 1,
    path: 'src/main.ts',
    line: 52,
    body: '### Missing null check\n\n`user` may be undefined here.\n\n<!-- mp:f=0123456789abcdef -->',
    user: { login: publisherLogin },
  },
];

const client = { listReviewCommentsPage: async () => existing } as unknown as GitHubClient;

/** A judge answering every `noul` question with the value `pick` gives its new comment title. */
function fakeJudge(pick: (state: Record<string, { new: { title: string } }>, id: string) => number): Judge & { calls: JudgeRequest[] } {
  const calls: JudgeRequest[] = [];
  return {
    label: 'typesafe:jev-latest',
    entries: [{ provider: 'typesafe', model: 'jev-latest', hasKey: true }],
    calls,
    decide: vi.fn(async (request: JudgeRequest) => {
      calls.push(request);
      const pairs = (request.state as { pairs: Record<string, { new: { title: string } }> }).pairs;
      const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: pick(pairs, id) }]));
      return { provider: 'typesafe', model: 'jev-latest', fallbackIndex: 0, answers, usage: { inputTokens: 50, outputTokens: 0 }, ms: 5, attempts: [] };
    }),
    report: () => ({ attempts: [], inputTokens: 50, outputTokens: 0 }),
  };
}

describe('deduplicateFindings — Jev semantic check', () => {
  const params = { owner: 'o', repo: 'r', pull_number: 1, publisherLogin };

  it('drops a paraphrased duplicate and keeps a different issue, in one request', async () => {
    const judge = fakeJudge((pairs, id) => (pairs[id]?.new.title.includes('undefined') ? 0.93 : 0.05));
    const result = await deduplicateFindings(client, {
      ...params,
      findings: [finding('dup', 50, 'User can be undefined before use'), finding('sql', 55, 'SQL built from input')],
      judge,
    });
    expect(judge.calls).toHaveLength(1);
    expect(Object.keys(judge.calls[0]!.questions)).toHaveLength(2);
    expect(result.kept.map((f) => f.id)).toEqual(['sql']);
    expect(result.dropped.map((f) => f.id)).toEqual(['dup']);
    expect(result.semantic).toEqual({ checked: 2, dropped: 1 });
  });

  it('asks only about comments within ±10 lines, and never when title already matched', async () => {
    const judge = fakeJudge(() => 1);
    const result = await deduplicateFindings(client, {
      ...params,
      findings: [finding('far', 80, 'Something else entirely'), finding('same', 52, 'Missing null check')],
      judge,
    });
    expect(judge.calls).toHaveLength(0);
    expect(result.kept.map((f) => f.id)).toEqual(['far']);
    expect(result.dropped.map((f) => f.id)).toEqual(['same']);
  });

  it('keeps everything and reports the code when the judge is unavailable', async () => {
    const judge = fakeJudge(() => 1);
    judge.decide = vi.fn(async () => {
      throw new JudgeUnavailableError('auth', []);
    });
    const result = await deduplicateFindings(client, { ...params, findings: [finding('a', 50, 'Reworded issue')], judge });
    expect(result.kept).toHaveLength(1);
    expect(result.semantic).toEqual({ checked: 0, dropped: 0, unavailable: 'auth' });
  });
});

describe('deduplicateFindings — only when the judge has the dedupe use', () => {
  const params = { owner: 'o', repo: 'r', pull_number: 1, publisherLogin };
  const reviewJudge = (uses: ReviewJudge['uses'], judge: Judge): ReviewJudge => ({ judge, uses, threshold: 0.35 });

  it('dedupe off: no semantic call, the paraphrase is published', async () => {
    for (const uses of [['annotate', 'filter', 'consensus'], []] as Array<ReviewJudge['uses']>) {
      const judge = fakeJudge(() => 0.99);
      const result = await deduplicateFindings(client, {
        ...params,
        findings: [finding('dup', 50, 'User can be undefined before use')],
        judge: dedupeJudgeOf(reviewJudge(uses, judge)),
      });
      expect(judge.calls).toHaveLength(0);
      expect(result.kept.map((f) => f.id)).toEqual(['dup']);
    }
  });

  it('dedupe on: the semantic call happens', async () => {
    const judge = fakeJudge(() => 0.99);
    const result = await deduplicateFindings(client, {
      ...params,
      findings: [finding('dup', 50, 'User can be undefined before use')],
      judge: dedupeJudgeOf(reviewJudge(['dedupe'], judge)),
    });
    expect(judge.calls).toHaveLength(1);
    expect(result.dropped.map((f) => f.id)).toEqual(['dup']);
    expect(dedupeJudgeOf(undefined)).toBeUndefined();
  });
});

describe('judge disclosure in the summary', () => {
  const base = {
    language: 'en' as const,
    summary: 'ok',
    summaryOnly: [],
    inlineCount: 1,
    complete: true,
    incompleteReasons: [],
    modelLabel: 'anthropic:m',
    outcome: 'completed' as const,
  };

  it('names the fallback that answered and lists filtered findings in a collapsible section', () => {
    const judge = judgeSummaryInput(
      {
        attempts: [{ provider: 'openrouter', model: 'x', ok: false, code: 'rate-limited', ms: 3 }],
        inputTokens: 10,
        outputTokens: 0,
        answeredBy: {
          provider: 'opencode-zen',
          model: 'jev-1.13-free',
          fallbackIndex: 2,
          before: [{ provider: 'openrouter', model: 'x', code: 'rate-limited', skipped: false }],
        },
      },
      { uses: ['filter', 'dedupe'], threshold: 0.35, checked: 2, filtered: [{ title: 'Nit', path: 'a.ts', line: 3, noul: 0.12 }] },
    );
    const md = renderReviewSummary({ ...base, judge });
    expect(md).toContain('Jev: `opencode-zen:jev-1.13-free (fallback 2; openrouter failed: rate-limited)`');
    expect(md).toContain('<summary>Filtered by Jev (1)</summary>');
    expect(md).toContain('- Nit · `a.ts:3` · 0.12');
    expect(md).toContain('> Jev uses: `filter`, `dedupe`');
  });

  it('names the configured uses, even when only the duplicate check ran (Arabic too)', () => {
    const report = { attempts: [{ provider: 'typesafe', model: 'jev-latest', ok: true, ms: 1 }], inputTokens: 5, outputTokens: 0 };
    const judge = judgeSummaryInput(report, undefined, ['dedupe', 'annotate']);
    expect(judge?.uses).toEqual(['annotate', 'dedupe']);
    expect(renderReviewSummary({ ...base, judge })).toContain('> Jev uses: `annotate`, `dedupe`');
    expect(renderReviewSummary({ ...base, language: 'ar', judge })).toContain('> استخدامات Jev: `annotate`، `dedupe`');
  });

  it('discloses the configured uses even when the judge made no request', () => {
    const idle = { attempts: [], inputTokens: 0, outputTokens: 0 };
    expect(judgeSummaryInput(idle, undefined, ['consensus'])).toEqual({ uses: ['consensus'] });
    expect(judgeSummaryInput(undefined, undefined, ['filter', 'dedupe'])).toEqual({ uses: ['filter', 'dedupe'] });
    expect(renderReviewSummary({ ...base, judge: judgeSummaryInput(idle, undefined, []) })).toContain('> Jev uses: —');
    // No judge configured: nothing to disclose.
    expect(judgeSummaryInput(undefined, undefined, undefined)).toBeUndefined();
  });

  it('says the judge was unavailable (Arabic too)', () => {
    const judge = judgeSummaryInput(
      { attempts: [{ provider: 'typesafe', model: 'jev-latest', ok: false, code: 'auth', ms: 1 }], inputTokens: 0, outputTokens: 0, unavailable: 'auth' },
      { findings: [], uses: ['filter'], threshold: 0.35, checked: 0, filtered: [], unavailable: 'auth' },
    );
    expect(renderReviewSummary({ ...base, judge })).toContain('Jev judge unavailable: auth');
    expect(renderReviewSummary({ ...base, language: 'ar', judge })).toContain('حَكَم Jev غير متاح: auth');
  });

  it('a failed duplicate check is not reported as an unfiltered review', () => {
    const judge = judgeSummaryInput(
      {
        attempts: [
          { provider: 'opencode-zen', model: 'jev-1.13-free', ok: true, ms: 1 },
          { provider: 'opencode-zen', model: 'jev-1.13-free', ok: false, code: 'timeout', ms: 1 },
        ],
        inputTokens: 10,
        outputTokens: 0,
        unavailable: 'timeout',
      },
      { findings: [], uses: ['filter'], threshold: 0.35, checked: 2, filtered: [] },
    );
    const text = renderReviewSummary({ ...base, judge });
    expect(text).toContain('Jev duplicate check unavailable: timeout');
    expect(text).not.toContain('published unfiltered');
  });

  it('adds judge tokens and known cost to the review totals', () => {
    const report = { attempts: [], inputTokens: 30, outputTokens: 0, costUsd: 0.001 };
    expect(withJudgeUsage(0.01, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, report)).toEqual({
      costUsd: 0.011,
      inputTokens: 130,
      outputTokens: 20,
    });
    expect(withJudgeUsage(undefined, undefined, { attempts: [], inputTokens: 0, outputTokens: 0 })).toEqual({});
  });

  it('leaves the total cost unknown when the review or a billed judge call has no known price', () => {
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // A free Jev call ($0) must not turn an unpriced review into "$0".
    const freeJudge = { attempts: [], inputTokens: 30, outputTokens: 0, costUsd: 0 };
    expect(withJudgeUsage(undefined, usage, freeJudge)).toEqual({ inputTokens: 130, outputTokens: 20 });
    // A priced review plus judge tokens of unknown price is not the review's cost alone.
    const unpricedJudge = { attempts: [], inputTokens: 30, outputTokens: 0 };
    expect(withJudgeUsage(0.01, usage, unpricedJudge)).toEqual({ inputTokens: 130, outputTokens: 20 });
    // No judge tokens: the review's cost stands.
    expect(withJudgeUsage(0.01, usage, { attempts: [], inputTokens: 0, outputTokens: 0 })).toEqual({
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 20,
    });
  });
});

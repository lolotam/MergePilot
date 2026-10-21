import { describe, expect, it, vi } from 'vitest';
import { parseReviewAnswer } from './answer.js';
import { retryUnusableAnswer } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { SpendTracker } from './spend.js';

// ADR-0042: the findings-list reminder must not lose the problems the first answer reported as
// withheld: the retry answers with the list, and its own answer may leave the withheld out.

const SUMMARY_ONLY = JSON.stringify({
  summary: 'Docs-only PR; no blocking defects found.',
  withheld: [{ title: 'A', reason: 'B' }],
});
const WITH_FINDINGS = JSON.stringify({ summary: 'Docs-only PR; no blocking defects found.', findings: [] });
const WITH_OWN_WITHHELD = JSON.stringify({
  summary: 'Docs-only PR; no blocking defects found.',
  findings: [],
  withheld: [{ title: 'C', reason: 'D' }],
});

const REQUEST: ReviewModelRequest = { system: 'S', user: 'U', maxOutputTokens: 100 };
const parse = (r: ReviewModelResponse) => parseReviewAnswer(r.text, { finishReason: r.finishReason });
const summaryOnly = parseReviewAnswer(SUMMARY_ONLY, { finishReason: 'stop' });

function modelReturning(...texts: string[]): ReviewModel & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn();
  for (const text of texts) generate.mockResolvedValueOnce({ text, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } });
  return { label: 'fake', generate };
}

const retry = (model: ReviewModel) => retryUnusableAnswer({
  parsed: summaryOnly, model, spend: new SpendTracker(undefined, 1), request: REQUEST, promptTokens: 10, requestedOutputTokens: 100, parse,
});

describe('the findings-list retry and the withheld list (ADR-0042)', () => {
  it('reads the first answer as a usable answer with the list missing', () => {
    expect(summaryOnly).toMatchObject({ ok: true, findings: [], findingsMissing: true });
  });

  it('keeps the withheld list of the first answer when the retry sends none', async () => {
    const model = modelReturning(WITH_FINDINGS);

    const result = await retry(model);

    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(result.parsed.ok).toBe(true);
    if (!result.parsed.ok) return;
    expect(result.parsed.withheld).toEqual([{ title: 'A', reason: 'B' }]);
  });

  it('keeps the withheld list the retry sends itself', async () => {
    const model = modelReturning(WITH_OWN_WITHHELD);

    const result = await retry(model);

    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(result.parsed.ok).toBe(true);
    if (!result.parsed.ok) return;
    expect(result.parsed.withheld).toEqual([{ title: 'C', reason: 'D' }]);
  });
});

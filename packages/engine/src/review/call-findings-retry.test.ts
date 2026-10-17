import { describe, expect, it, vi } from 'vitest';
import { LlmFailure } from '../llm/failure.js';
import { FINDINGS_MISSING_REASON, parseReviewAnswer } from './answer.js';
import { FINDINGS_LIST_REMINDER, retryUnusableAnswer } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';
import { SpendTracker } from './spend.js';

// Regression: lolotam/eyadex#81 (2026-10-17 18:44 UTC), claude-opus-5-5 on the subscription, with
// the response schema of #153 in its prompt, found nothing and answered a summary-only object.
const SUMMARY_ONLY = JSON.stringify({
  summary: 'This docs-only PR updates `CLAUDE.md`, `CLAUDE.architecture.md`, the PRD and the Lovable project ' +
    'knowledge to describe the system as it is in Phase B. No blocking defects found. A few claims cannot be ' +
    'confirmed from what is shown: the schema drift test and the module and worker job lists.',
});
const FULL = JSON.stringify({ summary: 'Docs-only PR; no blocking defects found.', findings: [] });

const REQUEST: ReviewModelRequest = { system: 'S', user: 'U', maxOutputTokens: 100 };
const parse = (r: ReviewModelResponse) => parseReviewAnswer(r.text, { finishReason: r.finishReason });
const summaryOnly = parseReviewAnswer(SUMMARY_ONLY, { finishReason: 'stop' });

function modelReturning(...texts: string[]): ReviewModel & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn();
  for (const text of texts) generate.mockResolvedValueOnce({ text, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } });
  return { label: 'fake', generate };
}

const retry = (model: ReviewModel, spend = new SpendTracker(undefined, 1)) => retryUnusableAnswer({
  parsed: summaryOnly, model, spend, request: REQUEST, promptTokens: 10, requestedOutputTokens: 100, parse,
});

describe('retryUnusableAnswer — an answer without a findings list', () => {
  it('reads the real summary-only answer as a usable answer with the list missing', () => {
    expect(summaryOnly).toMatchObject({ ok: true, findings: [], findingsMissing: true });
  });

  it('asks once more for the whole object and keeps the answer that has the list', async () => {
    const model = modelReturning(FULL);

    const result = await retry(model);

    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(model.generate).toHaveBeenCalledWith({ ...REQUEST, user: `U${FINDINGS_LIST_REMINDER}` });
    expect(result.parsed).toEqual({ ok: true, summary: 'Docs-only PR; no blocking defects found.', findings: [], droppedInvalid: 0 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.note).toBeUndefined();
  });

  it('keeps the list missing, still disclosed, when the second answer leaves it out too, without a third call', async () => {
    const model = modelReturning(SUMMARY_ONLY);

    const result = await retry(model);

    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(result.parsed).toMatchObject({ ok: true, findingsMissing: true });
    expect(result.response?.text).toBe(SUMMARY_ONLY);
  });

  it('keeps the first answer when the second is not usable, and never hands it to the truncation recovery', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ text: '{"summary": "cut', finishReason: 'max-tokens' });

    const result = await retry({ label: 'fake', generate });

    expect(result.parsed).toBe(summaryOnly);
    expect(result.response).toBeUndefined();
    expect(result.note).toMatch(/^findings-list retry unusable: truncated/);
  });

  it('skips the retry, disclosed, when the budget cannot afford it', async () => {
    const model = modelReturning(FULL);
    const spend = new SpendTracker({ inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }, 0.0001);

    const result = await retryUnusableAnswer({
      parsed: summaryOnly, model, spend, request: REQUEST, promptTokens: 10, requestedOutputTokens: 4096, parse,
    });

    expect(model.generate).not.toHaveBeenCalled();
    expect(result.parsed).toBe(summaryOnly);
    expect(result.note).toBe('findings-list retry skipped: budget limit reached');
  });

  it('keeps the first answer and discloses the failure code when the retry call fails', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new LlmFailure({ code: 'RATE_LIMIT', provider: 'anthropic', message: 'slow down' }));

    const result = await retry({ label: 'fake', generate });

    expect(result.parsed).toBe(summaryOnly);
    expect(result.note).toBe('findings-list retry failed: RATE_LIMIT');
  });
});

describe('a review whose model leaves the findings list out', () => {
  const review = (generate: ReviewModel['generate']) => runReview({
    config: makeConfig(),
    pr: { title: 'T', body: 'B' },
    files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model: { label: 'fake:test', generate },
    knownSecrets: [],
  });

  it('is complete when the reminder brings the list back', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValueOnce({ text: FULL, finishReason: 'stop' });

    const result = await review(generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'completed', complete: true, summary: 'Docs-only PR; no blocking defects found.' });
  });

  it('stays incomplete and keeps a redacted preview of each answer for the logs when the list never comes', async () => {
    const generate = vi.fn().mockResolvedValue({ text: SUMMARY_ONLY, finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2149 } });

    const result = await review(generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain(FINDINGS_MISSING_REASON);
      const attempt = {
        chars: SUMMARY_ONLY.length, finishReason: 'stop', outputTokens: 2149,
        preview: SUMMARY_ONLY.slice(0, 200), tail: SUMMARY_ONLY.slice(-200),
      };
      expect(result.answerAttempts).toEqual([attempt, attempt]);
    }
  });
});

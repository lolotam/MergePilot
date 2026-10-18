import { describe, expect, it, vi } from 'vitest';
import { LlmFailure } from '../llm/failure.js';
import { FINDINGS_MISSING_REASON, parseReviewAnswer } from './answer.js';
import { FINDINGS_LIST_REMINDER, remindMissingFindingsList, retryUnusableAnswer } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { makeConfig, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';
import { executeBatchedReview } from './batch-run.js';
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

  it('accepts the missing list as empty, still logged, when the second answer leaves it out too, without a third call', async () => {
    const model = modelReturning(SUMMARY_ONLY);

    const result = await retry(model);

    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(result.parsed).toMatchObject({ ok: true, findingsMissing: true, acceptedAsEmpty: true });
    expect(result.response?.text).toBe(SUMMARY_ONLY);
  });

  it.each(['max-tokens', 'length', 'error', 'end_turn', ''])('does not accept a summary-only %s reminder as empty', async (finishReason) => {
    const generate = vi.fn().mockResolvedValue({ text: SUMMARY_ONLY, finishReason });
    const result = await retry({ label: 'fake', generate });
    expect(result.parsed).toMatchObject({ ok: true, findingsMissing: true });
    expect(result.parsed).not.toHaveProperty('acceptedAsEmpty');
  });

  it.each(['', '   '])('does not accept an empty summary (%j)', async (summary) => {
    const result = await retry(modelReturning(JSON.stringify({ summary })));
    expect(result.parsed).not.toHaveProperty('acceptedAsEmpty');
  });

  it('keeps the first answer when the second is not usable, and never hands it to the truncation recovery', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ text: '{"summary": "cut', finishReason: 'max-tokens' });

    const result = await retry({ label: 'fake', generate });

    expect(result.parsed).toBe(summaryOnly);
    expect(result.response).toBeUndefined();
    expect(result.rejected?.text).toBe('{"summary": "cut');
    expect(result.note).toMatch(/^findings-list retry unusable: truncated/);
  });

  it('reminds only about the list after a truncation retry, leaving its other failures alone', async () => {
    const model = modelReturning(FULL);
    const cut = parseReviewAnswer('{"summary": "cut', { finishReason: 'max-tokens' });

    const result = await remindMissingFindingsList({
      parsed: cut, model, spend: new SpendTracker(undefined, 1), request: REQUEST, promptTokens: 10, requestedOutputTokens: 100, parse,
    });

    expect(model.generate).not.toHaveBeenCalled();
    expect(result.parsed).toBe(cut);
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

  it('completes and keeps a redacted preview of each answer for the logs when the list never comes', async () => {
    const generate = vi.fn().mockResolvedValue({ text: SUMMARY_ONLY, finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2149 } });

    const result = await review(generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(true);
      expect(result.result.incompleteReasons).not.toContain(FINDINGS_MISSING_REASON);
      const attempt = {
        chars: SUMMARY_ONLY.length, finishReason: 'stop', outputTokens: 2149,
        preview: SUMMARY_ONLY.slice(0, 200), tail: SUMMARY_ONLY.slice(-200),
      };
      expect(result.answerAttempts).toEqual([attempt, { ...attempt, acceptedAsEmpty: true }]);
    }
  });

  it.each([
    ['max-tokens', 'No defects.'],
    ['error', 'No defects.'],
    ['stop', ''],
    ['stop', '   '],
  ])('stays incomplete after a %s reminder with summary %j', async (finishReason, summary) => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValue({ text: JSON.stringify({ summary }), finishReason });
    const result = await review(generate);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.result.incompleteReasons).toContain(FINDINGS_MISSING_REASON);
    }
  });

  it.each([
    '{"summary":"draft"}\n{"summary":"Issues found","findings":null}',
    '{"summary":"Issues found","findings":null}\n{"summary":"draft"}',
    '{"summary":"draft"}\n{"summary": invalid}',
    '{"summary": invalid}\n{"summary":"draft"}',
  ])('stays incomplete when the stop reminder contains a rejected candidate: %s', async (text) => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValueOnce({ text, finishReason: 'stop' });

    const result = await review(generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.complete).toBe(false);
      expect(result.inline).toEqual([]);
      expect(result.result.incompleteReasons).toContain(FINDINGS_MISSING_REASON);
      expect(result.answerAttempts?.at(-1)).not.toHaveProperty('acceptedAsEmpty');
    }
  });

  it('keeps the unusable second answer in the previews too', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValueOnce({ text: '{"summary": "cut', finishReason: 'max-tokens' });

    const result = await review(generate);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result.incompleteReasons).toContain('findings-list retry unusable: truncated');
      expect(result.answerAttempts?.map((a) => a.preview)).toEqual([SUMMARY_ONLY.slice(0, 200), '{"summary": "cut']);
    }
  });

  it('reminds an answer that came from the truncation retry, at the size of that retry', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: '{"summary": "cut', finishReason: 'max-tokens' })
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValueOnce({ text: FULL, finishReason: 'stop' });

    const result = await review(generate);

    expect(generate).toHaveBeenCalledTimes(3);
    const [, retry, reminder] = generate.mock.calls.map(([request]) => request as ReviewModelRequest);
    expect(reminder).toMatchObject({ maxOutputTokens: retry?.maxOutputTokens, user: `${retry?.user}${FINDINGS_LIST_REMINDER}` });
    expect(result).toMatchObject({ status: 'completed', complete: true });
  });
});

describe('a truncated review whose retries leave the findings list out', () => {
  it('previews the cut answer, the truncation retry and the reminder in the logs', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: '{"summary": "cut', finishReason: 'max-tokens' })
      .mockResolvedValue({ text: SUMMARY_ONLY, finishReason: 'stop' });

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: { label: 'fake:test', generate },
      knownSecrets: [],
    });

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result.incompleteReasons).not.toContain(FINDINGS_MISSING_REASON);
      expect(result.answerAttempts?.map((a) => a.preview)).toEqual(
        ['{"summary": "cut', SUMMARY_ONLY.slice(0, 200), SUMMARY_ONLY.slice(0, 200)],
      );
    }
  });
});

describe('a batch whose truncation retry leaves the findings list out', () => {
  it('gets the reminder and is merged as complete', async () => {
    const patch = SIMPLE_PATCH;
    const answers = [
      { text: '{"summary": "cut', finishReason: 'max-tokens' }, // whole PR
      { text: '{"summary": "still cut', finishReason: 'max-tokens' }, // whole-PR truncation retry
      { text: '{"summary": "batch cut', finishReason: 'max-tokens' }, // batch 1
      { text: SUMMARY_ONLY, finishReason: 'stop' }, // batch 1 truncation retry
      { text: FULL, finishReason: 'stop' }, // batch 1 reminder
      { text: FULL, finishReason: 'stop' }, // batch 2
    ];
    const generate = vi.fn(async () => answers.shift() ?? { text: FULL, finishReason: 'stop' });

    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [
        { path: 'src/a.ts', status: 'modified', patch, changes: 3 },
        { path: 'src/b.ts', status: 'modified', patch, changes: 3 },
      ],
      rulesFiles: [],
      model: { label: 'fake:test', outputTokensFor: (max) => max, generate },
      knownSecrets: [],
    });

    expect(answers).toHaveLength(0);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result.incompleteReasons.join(' ')).not.toContain(FINDINGS_MISSING_REASON);
    }
  });
});

describe('summary-only reminder completeness in batches', () => {
  it.each([
    ['stop', 'No defects.', true],
    ['max-tokens', 'No defects.', false],
    ['error', 'No defects.', false],
    ['stop', '   ', false],
  ] as const)('%s with summary %j has complete=%s', async (finishReason, summary, complete) => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ text: SUMMARY_ONLY, finishReason: 'stop' })
      .mockResolvedValue({ text: JSON.stringify({ summary }), finishReason });
    const result = await executeBatchedReview({
      batches: [[{ path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }]],
      config: makeConfig(), pr: { title: 'T', body: 'B' }, rulesFiles: [],
      model: { label: 'fake', generate }, maxOutputTokens: 100, retryOutputTokens: 100,
      reviewOutputTokens: 100, spend: new SpendTracker(undefined, 1),
    });
    expect(result.merged?.findings).toEqual([]);
    expect(result.incompleteReasons.some((reason) => reason.includes(FINDINGS_MISSING_REASON))).toBe(!complete);
  });
});

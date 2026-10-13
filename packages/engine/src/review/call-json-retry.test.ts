import { describe, expect, it, vi } from 'vitest';
import { parseReviewAnswer } from './answer.js';
import { JSON_ONLY_REMINDER, retryUnusableAnswer } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { SpendTracker } from './spend.js';

const REQUEST: ReviewModelRequest = { system: 'S', user: 'U', maxOutputTokens: 100 };
const parse = (r: ReviewModelResponse) => parseReviewAnswer(r.text, { finishReason: r.finishReason });
const prose = parseReviewAnswer('Looks fine to me, no issues.', { finishReason: 'stop' });
const json = '{"summary": "ok", "findings": []}';

function modelReturning(...texts: string[]): ReviewModel & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn();
  for (const text of texts) generate.mockResolvedValueOnce({ text, finishReason: 'stop' });
  return { label: 'fake', generate };
}

describe('retryUnusableAnswer — an answer without the JSON asked for', () => {
  it('says the answer had no JSON object and how long it was', () => {
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.error).toBe('invalid-json: the answer has no JSON object (28 characters)');
  });

  it('retries once with a JSON-only reminder, keeping thinking as it was', async () => {
    const model = modelReturning(json);
    const result = await retryUnusableAnswer({
      parsed: prose, model, spend: new SpendTracker(undefined, 1), request: REQUEST, promptTokens: 10, requestedOutputTokens: 100, parse,
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(model.generate).toHaveBeenCalledWith({ ...REQUEST, user: `U${JSON_ONLY_REMINDER}` });
    expect(result.parsed.ok).toBe(true);
    expect(result.thinkingOff).toBe(false);
  });

  it('reports a second unusable answer as such, without a third call', async () => {
    const model = modelReturning('Still prose.');
    const result = await retryUnusableAnswer({
      parsed: prose, model, spend: new SpendTracker(undefined, 1), request: REQUEST, promptTokens: 10, requestedOutputTokens: 100, parse,
    });
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(result.parsed.ok).toBe(false);
    if (!result.parsed.ok) expect(result.parsed.error).toMatch(/\(also after asking for JSON only\)$/);
  });

  it('skips the retry, disclosed, when the budget cannot afford it', async () => {
    const model = modelReturning(json);
    const spend = new SpendTracker({ inputPerMTok: 0, outputPerMTok: 10, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }, 0.0001);
    const result = await retryUnusableAnswer({
      parsed: prose, model, spend, request: REQUEST, promptTokens: 10, requestedOutputTokens: 4096, parse,
    });
    expect(model.generate).not.toHaveBeenCalled();
    expect(result.note).toBe('invalid-json retry skipped: budget limit reached');
  });
});

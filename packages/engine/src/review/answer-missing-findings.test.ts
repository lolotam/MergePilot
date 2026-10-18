import { describe, expect, it } from 'vitest';
import { FINDINGS_MISSING_REASON, parseReviewAnswer } from './answer.js';
import { makeConfig, makeModel, SIMPLE_PATCH } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

describe('an answer without a findings list', () => {
  it('keeps the summary with no findings and flags the list as missing', () => {
    const result = parseReviewAnswer('{"summary":"Found several issues."}');
    expect(result).toEqual({
      ok: true,
      summary: 'Found several issues.',
      findings: [],
      droppedInvalid: 0,
      findingsMissing: true,
    });
  });

  it.each([
    '{"summary":"draft"}\n{"summary":"Issues found","findings":null}',
    '{"summary":"draft"}\n{"summary": invalid}',
  ])('keeps the first summary but records a rejected candidate: %s', (text) => {
    expect(parseReviewAnswer(text, { finishReason: 'stop' })).toEqual({
      ok: true, summary: 'draft', findings: [], droppedInvalid: 0,
      findingsMissing: true, otherCandidatesRejected: true,
    });
  });

  it('does not mark another valid summary-only candidate as rejected', () => {
    expect(parseReviewAnswer('{"summary":"draft"}\n{"summary":"final"}')).toEqual({
      ok: true, summary: 'draft', findings: [], droppedInvalid: 0, findingsMissing: true,
    });
  });

  it('prefers a candidate that has the list over an earlier summary-only object', () => {
    const text = 'Plan: {"summary":"draft"}\n{"summary":"Final.","findings":[]}';
    const result = parseReviewAnswer(text);
    expect(result).toEqual({ ok: true, summary: 'Final.', findings: [], droppedInvalid: 0 });
  });

  it('still rejects findings that are present but not a list, falsy values included', () => {
    for (const value of ['"none"', 'null', '0', '""', 'false']) {
      expect(parseReviewAnswer(`{"summary":"s","findings":${value}}`)).toMatchObject({ ok: false, code: 'invalid-json' });
    }
  });

  it('accepts a summary-only stop answer after the reminder', async () => {
    const result = await runReview({
      config: makeConfig(),
      pr: { title: 'T', body: 'B' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      rulesFiles: [],
      model: makeModel('{"summary":"Found several issues."}'),
      knownSecrets: [],
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.summary).toBe('Found several issues.');
      expect(result.inline).toEqual([]);
      expect(result.complete).toBe(true);
      expect(result.result.incompleteReasons).not.toContain(FINDINGS_MISSING_REASON);
    }
  });
});

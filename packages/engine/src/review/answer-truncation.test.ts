import { describe, expect, it } from 'vitest';
import { extractCandidateObjects, isTruncatedAnswer, parseReviewAnswer } from './answer.js';
import { parseVerifyAnswer } from './verify.js';

const VALID = JSON.stringify({ summary: 'ok', findings: [] });

describe('parseReviewAnswer — finishReason decides truncation first (ADR-0011)', () => {
  it('stop + prose containing `{` before the answer still parses the answer', () => {
    const text = `Use a map like { key: value. Here is the review:\n${VALID}`;
    const r = parseReviewAnswer(text, { finishReason: 'stop' });
    expect(r.ok).toBe(true);
  });

  it('stop + prose containing an unclosed `{` and no answer is invalid-json, not truncated', () => {
    const r = parseReviewAnswer('I think the fix is { obviously fine', { finishReason: 'stop' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-json');
  });

  it('stop + broken JSON is invalid-json (no expensive retry)', () => {
    const r = parseReviewAnswer('{"summary": "x", "findings": [', { finishReason: 'stop' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-json');
  });

  it('end_turn + broken JSON is invalid-json', () => {
    const r = parseReviewAnswer('{"summary": "x"', { finishReason: 'end_turn' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-json');
  });

  it('max-tokens + cut JSON is truncated', () => {
    const r = parseReviewAnswer('{"summary": "x", "findings": [{"path": "a.ts", "li', {
      finishReason: 'max-tokens',
      outputTokens: 4096,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('truncated');
      expect(r.error).toContain('outputTokens: 4096');
    }
  });

  it('a stream with no finish reason falls back to the structural check', () => {
    const cut = parseReviewAnswer('{"summary": "x", "findi');
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.code).toBe('truncated');
    const noFinishChunk = parseReviewAnswer('{"summary": "x", "findi', { finishReason: 'error' });
    expect(noFinishChunk.ok).toBe(false);
    if (!noFinishChunk.ok) expect(noFinishChunk.code).toBe('truncated');
    const closedButWrong = parseReviewAnswer('{"nope": 1}');
    expect(closedButWrong.ok).toBe(false);
    if (!closedButWrong.ok) expect(closedButWrong.code).toBe('invalid-json');
  });

  it('isTruncatedAnswer: explicit finish reasons win over structure', () => {
    expect(isTruncatedAnswer('max-tokens', false)).toBe(true);
    expect(isTruncatedAnswer('length', false)).toBe(true);
    expect(isTruncatedAnswer('stop', true)).toBe(false);
    expect(isTruncatedAnswer(undefined, true)).toBe(true);
    expect(isTruncatedAnswer(undefined, false)).toBe(false);
  });

  it('parseVerifyAnswer follows the same rule', () => {
    const stop = parseVerifyAnswer('{"verdicts": [', { finishReason: 'stop' });
    expect(stop.ok).toBe(false);
    if (!stop.ok) expect(stop.code).toBe('invalid-json');
    const cut = parseVerifyAnswer('{"verdicts": [', { finishReason: 'max-tokens' });
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.code).toBe('truncated');
  });
});

describe('extractCandidateObjects — string state', () => {
  it('quotes in prose outside an object do not flip string state', () => {
    const text = `He said "don't { worry and then:\n${VALID}`;
    const { candidates } = extractCandidateObjects(text);
    expect(candidates).toContain(VALID);
  });

  it('an unbalanced quote inside one object does not leak into the next object', () => {
    const first = '{"a": "x}';
    const text = `${first}\n} trailing\n${VALID}`;
    const r = parseReviewAnswer(text, { finishReason: 'stop' });
    expect(r.ok).toBe(true);
  });

  it('braces inside JSON strings are ignored and escaped quotes handled', () => {
    const answer = JSON.stringify({ summary: 'use {x} and \\"q\\"', findings: [] });
    const { candidates, hasUnclosedObject } = extractCandidateObjects(`prose ${answer} prose`);
    expect(candidates).toEqual([answer]);
    expect(hasUnclosedObject).toBe(false);
  });

  it('reports an object that opened and never closed', () => {
    expect(extractCandidateObjects('{"summary": "x').hasUnclosedObject).toBe(true);
    expect(extractCandidateObjects('no json here "quoted').hasUnclosedObject).toBe(false);
  });
});

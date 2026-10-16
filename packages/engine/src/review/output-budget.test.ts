import { describe, expect, it } from 'vitest';
import {
  reviewOutputTokensFor,
  reviewRetryOutputTokens,
  verifyOutputTokensFor,
  verifyRetryOutputTokens,
} from './output-budget.js';

describe('output budgets by findings limit (ADR-0033)', () => {
  it('keeps the review budgets of the default limit', () => {
    expect([1, 5, 10].map(reviewOutputTokensFor)).toEqual([4096, 4096, 4096]);
    expect(reviewRetryOutputTokens(4096)).toBe(8192);
  });

  it('grows the review budget by 300 tokens per finding above ten, with a retry up to 32,768', () => {
    expect(reviewOutputTokensFor(20)).toBe(7024);
    expect(reviewOutputTokensFor(50)).toBe(16_024);
    expect(reviewRetryOutputTokens(16_024)).toBe(32_048);
    expect(reviewRetryOutputTokens(20_000)).toBe(32_768);
  });

  it('keeps the verification budgets for few findings and grows them with the findings checked', () => {
    expect([0, 5, 16].map(verifyOutputTokensFor)).toEqual([2048, 2048, 2048]);
    expect(verifyRetryOutputTokens(2048)).toBe(4096);
    expect(verifyOutputTokensFor(50)).toBe(6400);
    expect(verifyOutputTokensFor(500)).toBe(16_384);
    expect(verifyRetryOutputTokens(10_000)).toBe(16_384);
  });
});

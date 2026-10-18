import { describe, expect, it } from 'vitest';
import { claimSimilarity, claimWords, sameClaim } from './claim-similarity.js';

describe('claimWords', () => {
  it('keeps content words of the title and body, split at camelCase, without the Jev confidence line', () => {
    const words = claimWords({
      title: 'The replays skip applySavedLineEdit',
      body: 'It replaced 2 totals.\n\n<sub>Jev confidence: 0.55</sub>\n\n<sub>ثقة Jev: 0.55</sub>',
    });
    expect([...words].sort()).toEqual(['apply', 'edit', 'line', 'replac', 'replay', 'saved', 'skip', 'total']);
  });
});

describe('sameClaim', () => {
  it('needs both the coefficient and a few shared words', () => {
    const a = { title: 'Null check', body: 'The value may be null here.' };
    // Identical short claims share only three words: too few to decide by wording.
    expect(claimSimilarity(a, a)).toEqual({ score: 1, shared: 3 });
    expect(sameClaim(a, a)).toBe(false);
    const long = { title: 'Stale replay overwrites the session total', body: 'A replayed response replaces the refreshed session total.' };
    expect(sameClaim(long, { ...long, title: 'Replay overwrites the refreshed total' })).toBe(true);
  });
});

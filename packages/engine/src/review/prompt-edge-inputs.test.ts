import { describe, expect, it } from 'vitest';
import type { FollowUp } from './follow-up.js';
import { buildReviewPrompt, type PromptInput } from './prompt.js';

// ADR-0043: the edge-inputs section on every review and the fix re-check on follow-up reviews only.

const FOLLOW_UP: FollowUp = { sinceSha: 'abcdef1', openFindings: [] };

function system(
  language: string,
  followUp?: FollowUp,
  batch?: PromptInput['batch'],
  rulesFiles: PromptInput['rulesFiles'] = [],
): string {
  const input: PromptInput = {
    language,
    maxFindings: 5,
    pr: { title: 'T', body: 'B', ...(followUp ? { followUp } : {}) },
    rulesFiles,
    pathInstructions: [],
    files: [{ path: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n a\n+b' }],
    ...(batch ? { batch } : {}),
  };
  return buildReviewPrompt(input).system;
}

/** One prompt section: from its marker up to the next blank line, or the end of the prompt. */
function section(text: string, start: string): string {
  const from = text.indexOf(start);
  const rest = text.slice(from);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe('edge inputs and fix re-check (ADR-0043)', () => {
  it.each(['en', 'ar'])('in %s, asks for the edge inputs of every changed parser', (language) => {
    // The section names stay English in an Arabic review, like the rest of the system prompt.
    const prompt = system(language);
    expect(prompt).toContain('EDGE INPUTS:');
    expect(prompt).toContain('whitespace-only');
    expect(prompt).toContain('malformed or non-object JSON');
    expect(prompt).toContain('rolled past a month or year end');
  });

  it('gives a batched call the edge-inputs section too', () => {
    expect(system('en', undefined, { number: 1, count: 2, manifest: 'x' })).toContain('EDGE INPUTS:');
  });

  it('puts the edge-inputs section after the checklist, the pattern sweep and the rules check', () => {
    // A rules file makes the prompt carry RULES CHECK (ADR-0039), so every marker below is present.
    const prompt = system('en', undefined, undefined, [{ path: 'AGENTS.md', content: 'Every refusal writes a log row.' }]);
    const order = ['CHECKLIST:', 'PATTERN SWEEP:', 'RULES CHECK:', 'EDGE INPUTS:', 'SEVERITY is impact'].map((marker) =>
      prompt.indexOf(marker),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('gives a follow-up review the edge-inputs section too', () => {
    expect(system('en', FOLLOW_UP)).toContain('EDGE INPUTS:');
  });

  it.each(['en', 'ar'])('in %s, re-checks the fixes of a follow-up review', (language) => {
    const prompt = system(language, FOLLOW_UP);
    expect(prompt).toContain('FIX RE-CHECK:');
    expect(prompt).toContain('what it newly allows');
    expect(prompt).toContain('partial-failure or retry path');
    expect(prompt.indexOf('FOLLOW-UP:')).toBeLessThan(prompt.indexOf('FIX RE-CHECK:'));
  });

  it('gives a whole-PR review no fix re-check', () => {
    expect(system('en')).not.toContain('FIX RE-CHECK:');
  });

  it('keeps the two new sections inside their word budgets', () => {
    // ADR-0043 budget: about 120 words in total on a follow-up call (70 + 48 as written).
    const edge = words(section(system('en'), 'EDGE INPUTS:'));
    const recheck = words(section(system('en', FOLLOW_UP), 'FIX RE-CHECK:'));
    expect(edge).toBeLessThanOrEqual(70);
    expect(recheck).toBeLessThanOrEqual(50);
    expect(edge + recheck).toBeLessThanOrEqual(120);
  });
});

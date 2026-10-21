/**
 * The verification pass and `budget.maxInputTokens` (ADR-0044): the verification prompt must fit
 * the limit, so the owner's rules give up the overflow, then are left out, and a prompt that
 * still does not fit is never sent.
 */

import { describe, expect, it } from 'vitest';
import { estimateTokens } from './budget.js';
import { JSON_ONLY_REMINDER } from './call.js';
import type { ReviewModel, ReviewModelRequest, ReviewModelResponse } from './model.js';
import { SpendTracker } from './spend.js';
import type { Finding } from './types.js';
import { buildVerifyPrompt } from './verify.js';
import { runVerifyPass, type VerifyPassInput } from './verify-pass.js';

const FINDING: Finding = {
  id: 'f1',
  path: 'src/a.ts',
  line: 2,
  side: 'RIGHT',
  title: 'Breaks the owner rule',
  body: 'The added line breaks the rule the finding cites.',
  severity: 'high',
  category: 'project-rule',
  evidence: 'const b = 2;',
  ruleRef: 'CLAUDE.md §1',
  confidence: 0.9,
};

/** One hunk: the added line is line 2 of the new file. */
const PATCH = ['@@ -1,1 +1,2 @@', ' const a = 1;', '+const b = 2;'].join('\n');

const FILES = [{ path: 'src/a.ts', patch: PATCH }];

/**
 * The owner's rules file, big enough that the criteria cap (4000 tokens) bites: the overflow is
 * then taken off the rules, which is what the shortening step does.
 */
const RULES_CONTENT = Array.from(
  { length: 200 },
  (_, index) => `rule line ${index + 1} ${'x'.repeat(60)}`,
).join('\n');

const RULES_FILES = [{ path: 'CLAUDE.md', content: RULES_CONTENT }];

/**
 * A small rules file, far below the criteria cap (4000 tokens): the shortening step must cut it
 * instead of leaving it out. It is still bigger than the criteria cut threshold (200 tokens),
 * below which a block is shown whole or not at all.
 */
const SMALL_RULES_CONTENT = Array.from(
  { length: 40 },
  (_, index) => `rule line ${index + 1} ${'x'.repeat(10)}`,
).join('\n');

const SMALL_RULES_FILES = [{ path: 'CLAUDE.md', content: SMALL_RULES_CONTENT }];

const VERIFY_ANSWER = JSON.stringify({
  verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'ok' }],
});

/** A model that records every request and confirms the one finding. */
function makeModel(): { model: ReviewModel; calls: ReviewModelRequest[] } {
  const calls: ReviewModelRequest[] = [];
  const model: ReviewModel = {
    label: 'fake:verify-pass',
    generate: async (request: ReviewModelRequest): Promise<ReviewModelResponse> => {
      calls.push(request);
      return { text: VERIFY_ANSWER, finishReason: 'stop' };
    },
  };
  return { model, calls };
}

/** The verification prompt without the owner's rules: the size every limit is measured against. */
function noRulesTokens(findings: readonly Finding[] = [FINDING]): number {
  const prompt = buildVerifyPrompt({
    language: 'en',
    findings: [...findings],
    files: FILES,
    rulesFiles: undefined,
    pathInstructions: undefined,
  });
  return estimateTokens(prompt.system + prompt.user);
}

/** The verification prompt with the owner's rules: the size a small-rules limit is measured from. */
function withRulesTokens(rulesFiles: readonly { path: string; content: string }[]): number {
  const prompt = buildVerifyPrompt({
    language: 'en',
    findings: [FINDING],
    files: FILES,
    rulesFiles: [...rulesFiles],
    pathInstructions: [],
  });
  return estimateTokens(prompt.system + prompt.user);
}

function makeInput(model: ReviewModel, maxInputTokens?: number): VerifyPassInput {
  return {
    language: 'en',
    findings: [FINDING],
    files: FILES,
    rulesFiles: RULES_FILES,
    pathInstructions: [],
    maxInputTokens,
    model,
    // Generous pricing and limit: the call is never refused for its cost here.
    spend: new SpendTracker(
      { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 },
      100,
    ),
    knownSecrets: [],
    totalUsage: undefined,
  };
}

describe('verify pass - the prompt and budget.maxInputTokens', () => {
  it('shows the owner rules and mentions no limit when no limit is given', async () => {
    const { model, calls } = makeModel();

    const result = await runVerifyPass(makeInput(model));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:CLAUDE.md>>>');
    expect(result.incompleteReasons.some((reason) => reason.includes('maxInputTokens'))).toBe(false);
  });

  it('shortens the owner rules when the prompt does not fit the limit', async () => {
    const { model, calls } = makeModel();

    const result = await runVerifyPass(
      makeInput(model, noRulesTokens() + 700 + estimateTokens(JSON_ONLY_REMINDER)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:CLAUDE.md>>>');
    expect(calls[0]?.user).toContain('[verification limit: the rest of this rules block was not shown]');
    expect(result.incompleteReasons).toContain('verification rules shortened to fit maxInputTokens');
  });

  it('cuts small owner rules instead of leaving them out', async () => {
    const { model, calls } = makeModel();
    // The prompt is a little over the limit: a small cut of the rules makes it fit.
    const limit = withRulesTokens(SMALL_RULES_FILES) - 40 + estimateTokens(JSON_ONLY_REMINDER);

    const result = await runVerifyPass({ ...makeInput(model, limit), rulesFiles: SMALL_RULES_FILES });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('<<<REVIEW_CRITERIA:RULES_FILE:CLAUDE.md>>>');
    expect(calls[0]?.user).toContain('[verification limit: the rest of this rules block was not shown]');
    expect(result.incompleteReasons).toContain('verification rules shortened to fit maxInputTokens');
  });

  it('shows the verification without the owner rules when the rules do not fit the limit', async () => {
    const { model, calls } = makeModel();

    const result = await runVerifyPass(
      makeInput(model, noRulesTokens() + 20 + estimateTokens(JSON_ONLY_REMINDER)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).not.toContain('<<<REVIEW_CRITERIA:');
    expect(result.incompleteReasons).toContain(
      'verification shown without the owner rules to fit maxInputTokens',
    );
  });

  it('discloses no rule step when no rule was shown and the code alone is over the limit', async () => {
    const { model, calls } = makeModel();
    const input = makeInput(model, 10);

    const result = await runVerifyPass({ ...input, findings: [{ ...FINDING, ruleRef: undefined }] });

    expect(calls).toHaveLength(0);
    expect(result.incompleteReasons.some((reason) => reason.includes('owner rules'))).toBe(false);
    expect(result.incompleteReasons.some((reason) => reason.startsWith('verification skipped: Estimated'))).toBe(true);
  });

  it('skips the verification when the prompt does not fit the limit at all', async () => {
    const { model, calls } = makeModel();

    const result = await runVerifyPass(makeInput(model, 10));

    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual([FINDING]);
    expect(
      result.incompleteReasons.some((reason) =>
        reason.startsWith('verification skipped: Estimated prompt tokens'),
      ),
    ).toBe(true);
    // The rules were not left out to fit the limit: the prompt did not fit either, so the skip
    // reason stands alone.
    expect(result.incompleteReasons).not.toContain(
      'verification shown without the owner rules to fit maxInputTokens',
    );
  });

  it('reserves the room the JSON-only retry needs, so a prompt that leaves none is skipped', async () => {
    const { model, calls } = makeModel();
    const findings = [{ ...FINDING, ruleRef: undefined }];
    // One token short of the room the retry's reminder needs.
    const limit = noRulesTokens(findings) + estimateTokens(JSON_ONLY_REMINDER) - 1;

    const result = await runVerifyPass({ ...makeInput(model, limit), findings });

    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual(findings);
    expect(
      result.incompleteReasons.some((reason) =>
        reason.startsWith('verification skipped: Estimated prompt tokens'),
      ),
    ).toBe(true);
  });
});

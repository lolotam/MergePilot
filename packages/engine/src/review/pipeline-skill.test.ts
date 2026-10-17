import { describe, expect, it } from 'vitest';
import type { MergePilotConfig } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type PrFile, type RunReviewInput } from './pipeline.js';

// ADR-0034 in the pipeline: the skill reaches every review call (batches and follow-ups included),
// counts in the prompt-token guard, is redacted, and never reaches the verify pass.

const skill = { name: 'Cross-file', content: '- check every consumer of a changed contract' };

function patchOf(lines = 25): string {
  const added = Array.from({ length: lines }, (_, i) => `+const v${i} = ${i};`);
  return [`@@ -0,0 +1,${lines} @@`, ...added].join('\n');
}

const files: PrFile[] = Array.from({ length: 3 }, (_, i) => ({
  path: `src/f${i}.ts`,
  status: 'added',
  patch: patchOf(),
  changes: 25,
}));

function recordingModel(answer = makeAnswerJson([])): { model: ReviewModel; requests: ReviewModelRequest[] } {
  const requests: ReviewModelRequest[] = [];
  return {
    requests,
    model: {
      label: 'fake:skill',
      generate: async (req) => {
        requests.push(req);
        return { text: answer, finishReason: 'stop' };
      },
    },
  };
}

function input(model: ReviewModel, config: MergePilotConfig, overrides: Partial<RunReviewInput> = {}): RunReviewInput {
  return { config, pr: { title: 'PR', body: '' }, files, rulesFiles: [], model, knownSecrets: [], skill, ...overrides };
}

describe('runReview — review skill (ADR-0034)', () => {
  it('sends the skill to every batch call', async () => {
    const base = makeConfig();
    const config = makeConfig({ review: { ...base.review, maxPromptTokens: 1, batchTokens: 250 } });
    const { model, requests } = recordingModel();
    await runReview(input(model, config));
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((r) => r.system.includes('<<<REVIEW_SKILL:Cross-file>>>'))).toBe(true);
  });

  it('sends the skill to a follow-up review', async () => {
    const { model, requests } = recordingModel();
    await runReview(input(model, makeConfig(), { followUp: { sinceSha: 'abc1234', openFindings: [] } }));
    expect(requests[0]!.system).toContain('follow-up review');
    expect(requests[0]!.system).toContain('<<<REVIEW_SKILL:Cross-file>>>');
  });

  it('keeps the skill out of the verify pass', async () => {
    const base = makeConfig();
    const config = makeConfig({ review: { ...base.review, verify: true } });
    const finding = validFindingJson({ path: 'src/f0.ts', line: 3, evidence: 'const v2 = 2;' });
    const { model, requests } = recordingModel(makeAnswerJson([finding]));
    await runReview(input(model, config, { files: [files[0]!] }));
    const verify = requests.filter((r) => r.system.startsWith("You are verifying another reviewer's findings"));
    expect(verify.length).toBeGreaterThan(0);
    expect(verify.every((r) => !`${r.system}${r.user}`.includes('REVIEW_SKILL'))).toBe(true);
  });

  it('counts the skill in the prompt-token guard', async () => {
    const big = { name: 'Big', content: 'x'.repeat(28_000) };
    const { model: probe, requests } = recordingModel();
    await runReview(input(probe, makeConfig(), { skill: undefined }));
    const baseTokens = Math.ceil((requests[0]!.system.length + requests[0]!.user.length) / 3.5);

    const config = makeConfig({ budget: { perReviewUsd: 0.5, maxInputTokens: baseTokens + 1000 } });
    const { model: fits } = recordingModel();
    expect((await runReview(input(fits, config, { skill: undefined }))).status).toBe('completed');
    const { model, requests: sent } = recordingModel();
    const result = await runReview(input(model, config, { skill: big }));
    expect(result.status).toBe('skipped-budget');
    expect(sent).toHaveLength(0);
  });

  it('redacts known secrets in the skill', async () => {
    const value = 'workspace-only-value-1234567890';
    const { model, requests } = recordingModel();
    await runReview(input(model, makeConfig(), {
      skill: { name: 'Leaky', content: `token ${value}` },
      knownSecrets: [new Secret(value)],
    }));
    expect(requests[0]!.system).not.toContain(value);
    expect(requests[0]!.system).toContain('<<<REVIEW_SKILL:Leaky>>>');
  });
});

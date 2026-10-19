import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import { estimateTokens } from './budget.js';
import type { RepositoryContextFile } from './context.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type RunReviewInput } from './pipeline.js';

// ADR-0029 in the pipeline: context reaches each call redacted, a batch gets only its own files'
// context, the budget preflight counts it, `review.contextTokens: 0` turns it off, and the verify
// pass can show a context file a finding names.

function recordingModel(answers: string[] = []): { model: ReviewModel; requests: ReviewModelRequest[] } {
  const requests: ReviewModelRequest[] = [];
  return {
    requests,
    model: {
      label: 'fake:ctx',
      generate: async (req) => {
        requests.push(req);
        return { text: answers.shift() ?? makeAnswerJson([]), finishReason: 'stop' };
      },
    },
  };
}

function context(path: string, forPath: string, content = `export const fromContext = '${path}';`): RepositoryContextFile {
  return { path, content, reason: `imported by ${forPath}`, kind: 'import', forPaths: [forPath] };
}

function input(model: ReviewModel, overrides: Partial<RunReviewInput> = {}, review: Record<string, unknown> = {}): RunReviewInput {
  const base = makeConfig();
  return {
    config: makeConfig({ review: { ...base.review, verify: false, ...review } }),
    pr: { title: 'PR', body: '' },
    files: [{ path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model,
    knownSecrets: [],
    ...overrides,
  };
}

/** A patch of about `lines` × 8 estimated tokens. */
function bigPatch(lines: number): string {
  return `@@ -1,1 +1,${lines + 1} @@\n const a = 1;\n${Array.from({ length: lines }, (_, i) => `+const value${i} = ${i};`).join('\n')}`;
}

describe('runReview — repository context (ADR-0029)', () => {
  it.each([0, 100_000])('fits context into one small-PR call with scaling %i and prices only what is sent', async (contextTokensPerFile) => {
    const baseline = recordingModel();
    await runReview(input(baseline.model));
    const bareTokens = estimateTokens(baseline.requests[0]!.system + baseline.requests[0]!.user);
    const maxPromptTokens = bareTokens + 800;
    const { model, requests } = recordingModel();
    const offered = Array.from({ length: 8 }, (_, i) => context(`src/ref${i}.ts`, 'src/a.ts', 'const value = 1;\n'.repeat(30)));
    const reviewInput = input(model, { contextFiles: offered }, { contextTokens: 120_000, contextTokensPerFile, maxPromptTokens });
    reviewInput.config.budget = {
      perReviewUsd: (maxPromptTokens + 1) / 10_000,
      maxInputTokens: maxPromptTokens,
      pricing: { inputPerMTok: 100, outputPerMTok: 0 },
    };
    const result = await runReview(reviewInput);

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(1);
    const sentTokens = estimateTokens(requests[0]!.system + requests[0]!.user);
    expect(sentTokens).toBeLessThanOrEqual(maxPromptTokens);
    expect(requests[0]!.user).not.toContain('UNTRUSTED:PR_MANIFEST');
    expect(result.status === 'completed' && result.context?.sent.length).toBeGreaterThan(0);
    if (result.status !== 'completed') throw new Error('expected completed review');
    expect(result.context!.sent.length).toBeLessThan(offered.length);
    expect(result.context!.sent.length + result.context!.leftOut.length).toBe(offered.length);
    for (const path of result.context!.sent) expect(requests[0]!.user).toContain(`REPOSITORY_CONTEXT:${path}>>>`);
    for (const path of result.context!.leftOut) expect(requests[0]!.user).not.toContain(`REPOSITORY_CONTEXT:${path}>>>`);
    expect(result.costUsd).toBeCloseTo(sentTokens / 10_000);
  });

  it('still batches when the prompt without context exceeds maxPromptTokens', async () => {
    const { model, requests } = recordingModel();
    await runReview(input(model, {
      files: ['src/a.ts', 'src/b.ts'].map((path) => ({ path, status: 'modified', patch: bigPatch(100), changes: 101 })),
      contextFiles: [context('src/dep.ts', 'src/a.ts')],
    }, { maxPromptTokens: 1_000, batchTokens: 800, contextTokens: 120_000 }));
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.user.includes('UNTRUSTED:PR_MANIFEST'))).toBe(true);
    expect(requests[0]!.user).toContain('REPOSITORY_CONTEXT:src/dep.ts');
  });

  it('drops context whose long fence labels exceed the remaining prompt room', async () => {
    const baseline = recordingModel();
    await runReview(input(baseline.model));
    const bareTokens = estimateTokens(baseline.requests[0]!.system + baseline.requests[0]!.user);
    const maxPromptTokens = bareTokens + 800;
    const { model, requests } = recordingModel();
    const path = `src/${'a'.repeat(2_000)}.ts`;
    const result = await runReview(input(model, { contextFiles: [{ ...context(path, 'src/a.ts', 'const x = 1;'), reason: 'cited' }] }, { maxPromptTokens }));
    expect(requests).toHaveLength(1);
    expect(estimateTokens(requests[0]!.system + requests[0]!.user)).toBeLessThanOrEqual(maxPromptTokens);
    expect(requests[0]!.user).not.toContain('UNTRUSTED:PR_MANIFEST');
    expect(result).toMatchObject({ status: 'completed', context: { sent: [], leftOut: [path] } });
  });

  it('forwards the batch context override independently of the diff batch size', async () => {
    const { model, requests } = recordingModel();
    await runReview(input(model, {
      contextFiles: [context('src/dep.ts', 'src/a.ts', 'const value = 1;\n'.repeat(100))],
    }, { maxPromptTokens: 1, batchTokens: 100, batchContextTokens: 2_000 }));
    expect(requests[0]?.user).toContain('REPOSITORY_CONTEXT:src/dep.ts');
  });

  it('counts the opt-in scaled whole-PR context in the model prompt', async () => {
    const { model, requests } = recordingModel();
    await runReview(input(model, {
      contextFiles: [context('src/dep.ts', 'src/a.ts', 'const value = 1;\n'.repeat(100))],
    }, { contextTokens: 100, contextTokensPerFile: 2_000 }));
    expect(requests[0]?.user).toContain('REPOSITORY_CONTEXT:src/dep.ts');
    expect(requests[0]?.user).not.toContain('[context truncated:');
  });

  it('sends the context with known secrets redacted and discloses what was sent', async () => {
    const secret = new Secret('workspace-known-value-42');
    const { model, requests } = recordingModel();
    const result = await runReview(
      input(model, {
        knownSecrets: [secret],
        contextFiles: [context('src/dep.ts', 'src/a.ts', `export const key = '${secret.reveal()}';`)],
      }),
    );

    const user = requests[0]?.user ?? '';
    expect(user).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:src/dep.ts>>>');
    expect(user).toContain('[REDACTED:known]');
    expect(user).not.toContain(secret.reveal());
    expect(result).toMatchObject({ status: 'completed', complete: true, context: { sent: ['src/dep.ts'], leftOut: [] } });
  });

  it('gives each batch only the context of its own files', async () => {
    const { model, requests } = recordingModel();
    await runReview(
      input(
        model,
        {
          files: [
            { path: 'src/a.ts', status: 'modified', patch: bigPatch(25), changes: 26 },
            { path: 'src/b.ts', status: 'modified', patch: bigPatch(25), changes: 26 },
          ],
          contextFiles: [context('src/for-a.ts', 'src/a.ts'), context('src/for-b.ts', 'src/b.ts')],
        },
        { maxPromptTokens: 100, batchTokens: 300 },
      ),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.user).toContain('REPOSITORY_CONTEXT:src/for-a.ts');
    expect(requests[0]?.user).not.toContain('src/for-b.ts');
    expect(requests[1]?.user).toContain('REPOSITORY_CONTEXT:src/for-b.ts');
    expect(requests[1]?.user).not.toContain('src/for-a.ts');
  });

  it('counts the context in the up-front budget check', async () => {
    const { model, requests } = recordingModel();
    const config = makeConfig();
    const budget = { perReviewUsd: 0.7, maxInputTokens: 200_000, pricing: { inputPerMTok: 100, outputPerMTok: 100 } };
    const priced = (contextFiles: RepositoryContextFile[]): RunReviewInput => ({
      ...input(model, { contextFiles }),
      config: { ...config, review: { ...config.review, verify: false }, budget },
    });
    // The review alone is about $0.59 at $100/MTok; about 5,000 more tokens of context (~$0.50) is over $0.70.
    const large = context('src/dep.ts', 'src/a.ts', 'export const filler = 1; // context line\n'.repeat(420));

    expect((await runReview(priced([]))).status).toBe('completed');
    const result = await runReview(priced([large]));
    expect(result.status).toBe('skipped-budget');
    expect(requests).toHaveLength(1);
  });

  it('sends nothing when review.contextTokens is 0', async () => {
    const { model, requests } = recordingModel();
    const result = await runReview(input(model, { contextFiles: [context('src/dep.ts', 'src/a.ts')] }, { contextTokens: 0 }));

    expect(requests[0]?.user).not.toContain('REPOSITORY_CONTEXT');
    expect(result.status === 'completed' && result.context).toBeUndefined();
  });

  it('shows the verifier a context file that a finding quotes', async () => {
    const finding = validFindingJson({ line: 2, evidence: 'src/dep.ts:1: export const fromContext' });
    const { model, requests } = recordingModel([
      makeAnswerJson([finding]),
      JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'shown' }] }),
    ]);
    await runReview(input(model, { contextFiles: [context('src/dep.ts', 'src/a.ts')] }, { verify: true }));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain('<<<UNTRUSTED:REPOSITORY_CONTEXT:src/dep.ts>>>');
  });
});

import { describe, expect, it } from 'vitest';
import type { RepositoryContextFile } from './context.js';
import type { FollowUp } from './follow-up.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import { runReview, type PrFile, type RunReviewInput } from './pipeline.js';

// ADR-0030 in the pipeline: a follow-up review shows the rest of the PR and the open findings to
// every call (batches too), anchors findings only in the reviewed files, and a whole-PR review is
// unchanged even when PR context is offered.

const OTHER_PATCH = '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;';

function recordingModel(answers: string[] = []): { model: ReviewModel; requests: ReviewModelRequest[] } {
  const requests: ReviewModelRequest[] = [];
  return {
    requests,
    model: {
      label: 'fake:follow-up',
      generate: async (req) => {
        requests.push(req);
        return { text: answers.shift() ?? makeAnswerJson([]), finishReason: 'stop' };
      },
    },
  };
}

function prChange(path: string, forPaths: string[] = []): RepositoryContextFile {
  return { path, content: OTHER_PATCH, reason: 'changed earlier in this pull request', kind: 'pr-change', forPaths };
}

const followUp: FollowUp = {
  sinceSha: 'abc1234def5678',
  openFindings: [{ id: '9', path: 'src/a.ts', line: 2, title: 'Old finding', body: 'still here' }],
};

const delta: PrFile = { path: 'src/a.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 };
const prFiles: PrFile[] = [
  delta,
  { path: 'lib/other.ts', status: 'modified', patch: OTHER_PATCH, changes: 1 },
  { path: 'src/neighbor.ts', status: 'modified', patch: OTHER_PATCH, changes: 1 },
];

function input(model: ReviewModel, overrides: Partial<RunReviewInput> = {}, review: Record<string, unknown> = {}): RunReviewInput {
  const base = makeConfig();
  return {
    config: makeConfig({ review: { ...base.review, ...review } }),
    pr: { title: 'PR', body: '' },
    files: [delta],
    anchorFiles: prFiles,
    contextFiles: [prChange('lib/other.ts'), prChange('src/neighbor.ts', ['src/a.ts'])],
    followUp,
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

describe('runReview — follow-up review (ADR-0030)', () => {
  it('shows the rest of the PR and the open findings, and anchors findings only in the new changes', async () => {
    const { model, requests } = recordingModel([
      makeAnswerJson([
        validFindingJson({ path: 'src/a.ts', line: 2, title: 'New bug' }),
        validFindingJson({ path: 'lib/other.ts', line: 2, title: 'Bug in an earlier change' }),
      ]),
    ]);
    const result = await runReview(input(model));

    const { system, user } = requests[0]!;
    expect(system).toContain('this is a follow-up review of the changes pushed since abc1234');
    expect(user.indexOf('<<<UNTRUSTED:PR_CONTEXT:src/neighbor.ts>>>')).toBeGreaterThan(-1);
    expect(user.indexOf('<<<UNTRUSTED:PR_CONTEXT:src/neighbor.ts>>>')).toBeLessThan(user.indexOf('<<<UNTRUSTED:PR_CONTEXT:lib/other.ts>>>'));
    expect(user).toContain('<<<UNTRUSTED:OPEN_FINDINGS>>>\n- src/a.ts:2 — Old finding: still here');
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.inline.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(result.summaryOnly.map((f) => f.path)).toEqual(['lib/other.ts']);
    expect(result.context?.pr).toEqual({ sent: ['src/neighbor.ts', 'lib/other.ts'], leftOut: [] });
  });

  it('gives every batch the follow-up prompt and the PR files related to its own files first', async () => {
    const { model, requests } = recordingModel();
    const files: PrFile[] = [
      { path: 'src/a.ts', status: 'modified', patch: bigPatch(25), changes: 26 },
      { path: 'src/b.ts', status: 'modified', patch: bigPatch(25), changes: 26 },
    ];
    await runReview(
      input(
        model,
        { files, anchorFiles: files, contextFiles: [prChange('lib/for-a.ts', ['src/a.ts']), prChange('lib/for-b.ts', ['src/b.ts'])] },
        { maxPromptTokens: 100, batchTokens: 300 },
      ),
    );

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.system).toContain('this is a follow-up review of the changes pushed since abc1234');
      expect(request.user).toContain('<<<UNTRUSTED:OPEN_FINDINGS>>>');
    }
    const at = (i: number, path: string): number => requests[i]!.user.indexOf(`<<<UNTRUSTED:PR_CONTEXT:${path}>>>`);
    expect(at(0, 'lib/for-a.ts')).toBeGreaterThan(-1);
    expect(at(0, 'lib/for-a.ts')).toBeLessThan(at(0, 'lib/for-b.ts'));
    expect(at(1, 'lib/for-b.ts')).toBeGreaterThan(-1);
    expect(at(1, 'lib/for-b.ts')).toBeLessThan(at(1, 'lib/for-a.ts'));
  });

  it('keeps the follow-up and the PR context in the batches that recover a truncated answer', async () => {
    const requests: ReviewModelRequest[] = [];
    const cut = ['{"summary": "cut', '{"summary": "cut'];
    const model: ReviewModel = {
      label: 'fake:truncated',
      generate: async (req) => {
        requests.push(req);
        const text = cut.shift();
        return text ? { text, finishReason: 'max-tokens' } : { text: makeAnswerJson([]), finishReason: 'stop' };
      },
    };
    const files: PrFile[] = [delta, { path: 'src/b.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }];
    await runReview(input(model, { files, anchorFiles: files }));

    const recovery = requests.slice(2);
    expect(recovery.length).toBeGreaterThan(0);
    for (const request of recovery) {
      expect(request.system).toContain('this is a follow-up review of the changes pushed since abc1234');
      expect(request.user).toContain('<<<UNTRUSTED:PR_CONTEXT:');
    }
  });

  it('shows the verifier a PR file that a finding quotes, as PR_CONTEXT', async () => {
    const finding = validFindingJson({ path: 'src/a.ts', line: 2, evidence: 'lib/other.ts:2: const b = 2;' });
    const { model, requests } = recordingModel([
      makeAnswerJson([finding]),
      JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'shown' }] }),
    ]);
    await runReview(input(model, {}, { verify: true }));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain('<<<UNTRUSTED:PR_CONTEXT:lib/other.ts>>>');
  });

  it('leaves a whole-PR review unchanged: no PR context, no open findings, whole-PR wording', async () => {
    const { model, requests } = recordingModel();
    const { followUp: _ignored, ...withoutFollowUp } = input(model);
    const result = await runReview(withoutFollowUp);

    const { system, user } = requests[0]!;
    expect(system).toContain('the diff of every changed file of this pull request');
    expect(user).not.toContain('PR_CONTEXT');
    expect(user).not.toContain('OPEN_FINDINGS');
    expect(result.status === 'completed' && result.context).toBeUndefined();
  });
});

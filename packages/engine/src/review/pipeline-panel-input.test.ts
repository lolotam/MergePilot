import { describe, expect, it } from 'vitest';
import { makeAnswerJson, makeConfig, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import type { ReviewModel, ReviewModelRequest } from './model.js';
import { runReview } from './pipeline.js';

describe('runReview — rejected panel input (PR189)', () => {
  it('allows a shown caller to report a deletion consequence without exposing removed contents', async () => {
    const calls: ReviewModelRequest[] = [];
    const replies = [makeAnswerJson([validFindingJson({ title: 'Caller imports deleted module', line: 2, body: 'The shown caller imports src/removed.ts, which this PR deletes.' })]),
      JSON.stringify({ verdicts: [{ id: 'f1', verdict: 'confirmed', reason: 'The caller imports the deleted module.' }] })];
    const model: ReviewModel = { label: 'fake:deletion', generate: async (request) => {
      calls.push(request);
      return { text: replies.shift()!, finishReason: 'stop' };
    } };
    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }), pr: { title: '', body: '' },
      files: [
        { path: 'src/index.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n const a = 1;\n+import { removed } from "./removed.js";', changes: 1 },
        { path: 'src/removed.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-const UNSEEN_REMOVED_CONTENT = 1;', changes: 1 },
      ], rulesFiles: [], model, knownSecrets: [],
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Review did not complete');
    expect(result.inline.map(({ title }) => title)).toEqual(['Caller imports deleted module']);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.user).toContain('removed | +0 -1 | src/removed.ts | skip-removed');
      expect(call.user).not.toContain('UNSEEN_REMOVED_CONTENT');
      expect(call.system).toContain('consequences of removal are allowed');
      expect(call.system).toContain('make no claims about their unseen contents');
      expect(call.system).not.toContain('Never report them as not updated, missing or unchanged');
    }
  });
  it.each(['medium', 'high'] as const)('filters rejected votes by effective minSeverity=%s without capping them', async (minSeverity) => {
    const severities = ['info', 'low', 'medium', 'high'] as const;
    const replies = [
      makeAnswerJson(severities.map((severity) => validFindingJson({ severity, title: severity }))),
      JSON.stringify({ verdicts: severities.map((_, i) => ({ id: `f${i + 1}`, verdict: 'rejected', reason: 'Contradicted' })) }),
    ];
    const model: ReviewModel = { label: 'fake:reject', generate: async () => ({ text: replies.shift()!, finishReason: 'stop' }) };
    const config = makeConfig({ review: { ...makeConfig().review, minSeverity, maxFindings: 1, verify: true } });
    const result = await runReview({ config, pr: { title: '', body: '' }, files: [
      { path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 },
    ], rulesFiles: [], model, knownSecrets: [] });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Review did not complete');
    expect(result.verifyRejectedFindings?.map(({ finding }) => finding.severity)).toEqual(minSeverity === 'medium' ? ['medium', 'high'] : ['high']);
    expect(result.verifyRejected).toHaveLength(4);
    expect(result.inline).toEqual([]);
    expect(result.result).not.toHaveProperty('verifyRejectedFindings');
  });

  it('gives rejected copies the same incremental anchors as kept findings', async () => {
    const findings = [
      validFindingJson({ title: 'Previous-head deletion', side: 'LEFT', line: 1 }),
      validFindingJson({ title: 'Earlier PR file', path: 'src/earlier.ts', line: 2 }),
      validFindingJson({ title: 'Current change', line: 2 }),
    ];
    const replies = [makeAnswerJson(findings), JSON.stringify({ verdicts: findings.map((_, i) => ({ id: `f${i + 1}`, verdict: 'rejected', reason: 'Contradicted' })) })];
    const model: ReviewModel = { label: 'fake:reject', generate: async () => ({ text: replies.shift()!, finishReason: 'stop' }) };
    const result = await runReview({
      config: makeConfig({ review: { ...makeConfig().review, verify: true } }), pr: { title: '', body: '' },
      files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
      anchorFiles: ['src/index.ts', 'src/earlier.ts'].map((path) => ({ path, status: 'modified', patch: SIMPLE_PATCH, changes: 3 })),
      rulesFiles: [], model, knownSecrets: [],
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Review did not complete');
    expect(result.verifyRejectedFindings?.map(({ finding, kind }) => [finding.title, kind])).toEqual([
      ['Previous-head deletion', 'summaryOnly'], ['Earlier PR file', 'summaryOnly'], ['Current change', 'inline'],
    ]);
  });
});

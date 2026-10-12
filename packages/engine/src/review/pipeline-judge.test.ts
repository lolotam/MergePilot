import { describe, expect, it } from 'vitest';
import { createJudge } from '../judge/judge.js';
import { judgeSecret, noSleep, noulReply } from '../judge/judge.fixtures.js';
import { mockFetch, textResponse } from '../providers/fetch-mock.fixtures.js';
import { makeConfig, makeModel, SIMPLE_PATCH, validFindingJson } from './pipeline.fixtures.js';
import { runReview } from './pipeline.js';

const answer = JSON.stringify({
  summary: 'Two issues.',
  findings: [validFindingJson({ id: 'a', title: 'Real bug', line: 2 }), validFindingJson({ id: 'b', title: 'Nitpick', line: 3 })],
});

function review(fetch: Parameters<typeof createJudge>[0]['fetch'], mode: 'filter' | 'annotate' | 'off') {
  const judge = createJudge({ entries: [{ provider: 'typesafe', model: 'jev-latest', apiKey: judgeSecret() }], fetch, sleep: noSleep });
  return runReview({
    config: makeConfig({ review: { ...makeConfig().review, verify: false } }),
    pr: { title: 'T', body: 'B' },
    files: [{ path: 'src/index.ts', status: 'modified', patch: SIMPLE_PATCH, changes: 3 }],
    rulesFiles: [],
    model: makeModel(answer),
    knownSecrets: [],
    judge: { judge, mode, threshold: 0.35 },
  });
}

describe('runReview — Jev judge', () => {
  it('filters low-confidence findings after review and reports them', async () => {
    const { fetch, calls } = mockFetch(noulReply({ f1: 0.9, f2: 0.1 }));
    const result = await review(fetch, 'filter');
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect([...result.inline, ...result.summaryOnly].map((f) => f.title)).toEqual(['Real bug']);
    expect(result.judge).toEqual({
      mode: 'filter',
      threshold: 0.35,
      checked: 2,
      filtered: [{ title: 'Nitpick', path: 'src/index.ts', line: 3, noul: 0.1 }],
    });
    expect(result.complete).toBe(true);
  });

  it('proceeds unfiltered and discloses the code when the judge fails', async () => {
    const { fetch } = mockFetch(textResponse('down', 503));
    const result = await review(fetch, 'filter');
    if (result.status !== 'completed') throw new Error('expected completed');
    expect([...result.inline, ...result.summaryOnly]).toHaveLength(2);
    expect(result.judge?.unavailable).toBe('server');
  });

  it('skips the judge in off mode', async () => {
    const { fetch, calls } = mockFetch(noulReply({}));
    const result = await review(fetch, 'off');
    expect(calls).toHaveLength(0);
    if (result.status === 'completed') expect(result.judge).toBeUndefined();
  });
});

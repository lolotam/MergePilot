import { describe, expect, it } from 'vitest';
import { mockFetch, textResponse } from '../providers/fetch-mock.fixtures.js';
import { createJudge } from './judge.js';
import { judgeSecret, noSleep, noulReply } from './judge.fixtures.js';
import { judgeSameIssue, type SameIssuePair } from './same-issue.js';

const pair = (key: string, title: string): SameIssuePair => ({
  key,
  newComment: { path: 'a.ts', line: 10, title, body: 'details' },
  existingComment: { path: 'a.ts', line: 12, body: '### Null check missing\n\nx may be null' },
});

describe('judgeSameIssue', () => {
  const judgeWith = (fetch: Parameters<typeof createJudge>[0]['fetch']) =>
    createJudge({ entries: [{ provider: 'opencode-zen', model: 'jev-1.13-free', apiKey: judgeSecret() }], fetch, sleep: noSleep });

  it('batches every pair in one request and flags pairs at or above 0.8', async () => {
    const { fetch, calls } = mockFetch(noulReply({ p1: 0.8, p2: 0.3 }));
    const out = await judgeSameIssue({
      judge: judgeWith(fetch),
      pairs: [pair('dup', 'x can be undefined here'), pair('other', 'SQL injection')],
      knownSecrets: [],
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys((calls[0]?.body as { questions: object }).questions)).toEqual(['p1', 'p2']);
    expect([...out.duplicates]).toEqual(['dup']);
    expect(out.checked).toBe(2);
  });

  it('flags nothing when the judge is unavailable', async () => {
    const { fetch } = mockFetch(textResponse('down', 500));
    const out = await judgeSameIssue({ judge: judgeWith(fetch), pairs: [pair('a', 't')], knownSecrets: [] });
    expect(out.duplicates.size).toBe(0);
    expect(out.unavailable).toBe('server');
  });

  it('sends nothing for no pairs', async () => {
    const { fetch, calls } = mockFetch(noulReply({}));
    await judgeSameIssue({ judge: judgeWith(fetch), pairs: [], knownSecrets: [] });
    expect(calls).toHaveLength(0);
  });
});

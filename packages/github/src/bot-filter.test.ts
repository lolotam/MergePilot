import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient, GitHubReview, GitHubReviewComment } from './client.js';
import { deduplicateFindings } from './dedupe.js';
import { findLastReviewedMarker, selectIncrementalFiles } from './incremental.js';
import { buildMarker } from './marker.js';
import type { PullRequestFile } from './pr-files.js';
import { publishReview } from './publish.js';
import { renderFindingComment } from './render.js';

// The reviewer panel (ADR-0017): every lookup of an earlier MergePilot review or comment only
// considers the same bot's; a review or comment without a bot marker belongs to slot 1.

const LOGIN = 'mergepilot[bot]';
const HEAD = 'head-sha-1';

const finding: Finding = {
  id: 'f-1',
  path: 'src/a.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Null dereference',
  body: 'x may be null.',
  severity: 'high',
  category: 'correctness',
  evidence: 'x.y',
  confidence: 0.9,
};

const review = (id: number, marker: Parameters<typeof buildMarker>[0]): GitHubReview => ({
  id,
  body: `Summary\n\n${buildMarker(marker)}`,
  user: { login: LOGIN },
});

function client(reviews: GitHubReview[], comments: GitHubReviewComment[] = []) {
  const created: CreateReviewParams[] = [];
  const fake: GitHubClient = {
    getPullRequest: async () => ({ head: { sha: HEAD } }),
    listReviewsPage: async () => reviews,
    listReviewCommentsPage: async () => comments,
    listPullRequestFilesPage: async () => [],
    getFileContent: async () => null,
    compareCommits: vi.fn(async () => ({
      status: 'ahead' as const,
      totalCommits: 1,
      files: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@' }],
    })),
    createReview: async (params) => {
      created.push(params);
      return { id: 900 };
    },
  };
  return { fake, created };
}

const publishParams = (botSlot?: number) => ({
  owner: 'acme',
  repo: 'repo',
  pull_number: 5,
  expectedHeadSha: HEAD,
  summaryMarkdown: 'Summary',
  inline: [finding],
  configHash: 'cfg',
  language: 'en' as const,
  suggestionsAsCode: false,
  publisherLogin: LOGIN,
  alreadyDeduplicated: true,
  ...(botSlot ? { botSlot } : {}),
});

describe('publishReview per bot', () => {
  it('writes the bot slot in the marker and in every inline comment', async () => {
    const { fake, created } = client([]);
    const result = await publishReview(fake, publishParams(3));
    expect(result).toEqual({ status: 'published', reviewId: 900 });
    expect(created[0]?.body).toContain('<!-- mergepilot:review head=head-sha-1 config=cfg bot=3 -->');
    expect(created[0]?.comments[0]?.body.trimEnd().endsWith('<!-- mergepilot:bot=3 -->')).toBe(true);
  });

  it('slot 1 output is unchanged: no bot= and no inline bot marker', async () => {
    const { fake, created } = client([]);
    await publishReview(fake, publishParams());
    expect(created[0]?.body).toContain('<!-- mergepilot:review head=head-sha-1 config=cfg -->');
    expect(created[0]?.comments[0]?.body).not.toContain('mergepilot:bot=');
  });

  it("bot 2's review of this head does not block bot 3", async () => {
    const { fake, created } = client([review(11, { headSha: HEAD, configHash: 'cfg', bot: 2 })]);
    expect(await publishReview(fake, publishParams(3))).toEqual({ status: 'published', reviewId: 900 });
    expect(created).toHaveLength(1);
  });

  it("bot 3's own review of this head blocks bot 3", async () => {
    const { fake, created } = client([review(12, { headSha: HEAD, configHash: 'cfg', bot: 3 })]);
    expect(await publishReview(fake, publishParams(3))).toEqual({ status: 'skipped-duplicate', reviewId: 12 });
    expect(created).toHaveLength(0);
  });

  it('an old marker (no bot=) blocks slot 1 only', async () => {
    const old = [review(13, { headSha: HEAD, configHash: 'cfg' })];
    expect(await publishReview(client(old).fake, publishParams())).toEqual({ status: 'skipped-duplicate', reviewId: 13 });
    expect((await publishReview(client(old).fake, publishParams(2))).status).toBe('published');
  });
});

describe('incremental base per bot', () => {
  const reviews = [
    review(1, { headSha: 'sha-main', configHash: 'cfg' }),
    review(2, { headSha: 'sha-bot2', configHash: 'cfg', bot: 2 }),
  ];

  it("takes only the bot's own last marker", async () => {
    const { fake } = client(reviews);
    const params = { owner: 'acme', repo: 'repo', pull_number: 5, publisherLogin: LOGIN };
    expect((await findLastReviewedMarker(fake, params))?.headSha).toBe('sha-main');
    expect((await findLastReviewedMarker(fake, { ...params, botSlot: 2 }))?.headSha).toBe('sha-bot2');
    expect(await findLastReviewedMarker(fake, { ...params, botSlot: 4 })).toBeNull();
  });

  it('a bot with no review of its own gets a full first review', async () => {
    const { fake } = client(reviews);
    const prFiles: PullRequestFile[] = [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }];
    const base = { owner: 'acme', repo: 'repo', pull_number: 5, headSha: HEAD, publisherLogin: LOGIN, prFiles, configHash: 'cfg' };
    const forBot3 = await selectIncrementalFiles(fake, { ...base, botSlot: 3 });
    expect(forBot3).toMatchObject({ mode: 'full', reason: 'first review' });
    const forBot2 = await selectIncrementalFiles(fake, { ...base, botSlot: 2 });
    expect(forBot2).toMatchObject({ mode: 'incremental', sinceSha: 'sha-bot2' });
  });
});

describe('dedupe per bot', () => {
  const comment = (id: number, slot: number): GitHubReviewComment => ({
    id,
    path: 'src/a.ts',
    line: 10,
    body: renderFindingComment(finding, { language: 'en', suggestionsAsCode: false, botSlot: slot }),
    user: { login: LOGIN },
  });
  const params = { owner: 'acme', repo: 'repo', pull_number: 5, publisherLogin: LOGIN, findings: [finding] };

  it("drops a finding only against the same bot's comment", async () => {
    const { fake } = client([], [comment(1, 2)]);
    expect((await deduplicateFindings(fake, { ...params, botSlot: 2 })).dropped).toHaveLength(1);
    expect((await deduplicateFindings(fake, { ...params, botSlot: 3 })).kept).toHaveLength(1);
    expect((await deduplicateFindings(fake, params)).kept).toHaveLength(1);
  });

  it('a comment without a bot marker belongs to slot 1', async () => {
    const { fake } = client([], [comment(1, 1)]);
    expect((await deduplicateFindings(fake, params)).dropped).toHaveLength(1);
    expect((await deduplicateFindings(fake, { ...params, botSlot: 2 })).kept).toHaveLength(1);
  });

  it("semantic candidates are only the bot's own comments", async () => {
    const other: Finding = { ...finding, id: 'f-2', title: 'Totally different words here' };
    const { fake } = client([], [comment(1, 2)]);
    const decide = vi.fn(async () => ({ answers: {} }));
    const judge = { label: 'j', entries: [], decide, report: () => ({ attempts: [], inputTokens: 0, outputTokens: 0 }) };
    await deduplicateFindings(fake, { ...params, findings: [other], botSlot: 3, judge });
    expect(decide).not.toHaveBeenCalled();
    await deduplicateFindings(fake, { ...params, findings: [other], botSlot: 2, judge });
    expect(decide).toHaveBeenCalledOnce();
  });
});

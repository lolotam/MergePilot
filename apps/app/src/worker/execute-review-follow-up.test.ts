import { describe, expect, it } from 'vitest';
import type { MergePilotConfig, ReviewModel, ReviewModelRequest } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient, GitHubReviewComment, PullRequestFile } from '@mergepilot/github';
import type { AppStore } from '../core/types.js';
import { runBotReview } from './bot-review-run.js';
import { executeReview } from './execute-review.js';
import { wrapOctokit, type OctokitLike } from './octokit-client.js';
import { guardWritesForWorkspace } from './workspace-guard.js';

// ADR-0030 on the App path: an incremental bot review sees the rest of the PR and its open
// findings; a consensus bot re-checks slot 1's findings (the panel publishes as slot 1); the
// thread reader survives the App's client wrappers.

const PUBLISHER = 'mergepilot[bot]';
const lastHead = 'c3c3c3c3c3c3c3c3';
const headSha = 'd4d4d4d4d4d4d4d4';

const mainPatch = "@@ -1,1 +1,2 @@\n import { limit } from '../rate/limit.js';\n+limit();";
const limitPatch = '@@ -1,1 +1,2 @@\n export function limit() {}\n+export const MAX = 5;';

const config = {
  provider: 'anthropic',
  model: 'claude-x',
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: [], pathInstructions: [], verify: false },
  budget: { perReviewUsd: 10, maxInputTokens: 100_000 },
} as unknown as MergePilotConfig;

/** An open finding on svc/rate/limit.ts; `slot` 2-5 tags it as a panel bot's. */
function finding(id: number, title: string, slot?: number): GitHubReviewComment {
  const bot = slot ? `\n\n<!-- mergepilot:bot=${slot} -->` : '';
  return {
    id,
    path: 'svc/rate/limit.ts',
    line: 2,
    user: { login: PUBLISHER },
    body: `### ${title}\n\nMAX is unused.\n\n<!-- mp:f=${String(id).padStart(16, 'e')} -->${bot}`,
  };
}

function makeClient(created: CreateReviewParams[]): GitHubClient {
  return {
    listPullRequestFilesPage: async ({ page }) =>
      page > 1
        ? []
        : [
            { filename: 'svc/api/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: mainPatch },
            { filename: 'svc/rate/limit.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: limitPatch },
          ],
    getPullRequest: async () => ({ head: { sha: headSha } }),
    listReviewsPage: async () => [
      { id: 1, user: { login: PUBLISHER }, body: `<!-- mergepilot:review head=${lastHead} config=cfg -->` },
      { id: 2, user: { login: PUBLISHER }, body: `<!-- mergepilot:review head=${lastHead} config=cfg bot=3 -->` },
    ],
    listIssueCommentsPage: async () => [],
    listReviewCommentsPage: async ({ page }) => (page === 1 ? [finding(51, 'Slot one finding'), finding(52, 'Slot three finding', 3)] : []),
    listReviewThreads: async () => [
      { isResolved: false, firstCommentId: 51 },
      { isResolved: false, firstCommentId: 52 },
    ],
    createReview: async (params) => {
      created.push(params);
      return { id: 2 };
    },
    compareCommits: async ({ base }) =>
      base === lastHead
        ? { status: 'ahead', totalCommits: 1, files: [{ filename: 'svc/api/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: mainPatch }] }
        : null,
    getFileContent: async () => null,
  };
}

function recordingModel(requests: ReviewModelRequest[]): ReviewModel {
  return {
    label: 'anthropic:claude-x',
    outputTokensFor: (n: number) => n,
    generate: async (req) => {
      requests.push(req);
      return { text: JSON.stringify({ summary: 'Fine.', findings: [] }), finishReason: 'stop' };
    },
  };
}

const base = { owner: 'acme', repo: 'repo', pullNumber: 7, headSha, baseSha: 'base', prTitle: 'Feature', prBody: '', config, configHash: 'cfg', rulesFiles: [], publisherLogin: PUBLISHER };

describe('executeReview — follow-up review (ADR-0030)', () => {
  it('reviews the new changes with the rest of the PR and the open findings, and says so', async () => {
    const created: CreateReviewParams[] = [];
    const requests: ReviewModelRequest[] = [];
    const result = await executeReview({ ...base, client: makeClient(created), model: recordingModel(requests) });

    expect(result.outcome).toBe('completed');
    const { system, user } = requests[0]!;
    expect(system).toContain('this is a follow-up review of the changes pushed since c3c3c3c');
    expect(user).toContain('<<<UNTRUSTED:PR_CONTEXT:svc/rate/limit.ts>>>\nReason: changed earlier in this pull request; imported by svc/api/main.ts');
    expect(user).toContain('- svc/rate/limit.ts:2 — Slot one finding');
    expect(user).not.toContain('Slot three finding');
    expect(created[0]?.body ?? '').toContain('Rest of the pull request: 1 other changed file sent as context.');
    expect(created[0]?.body ?? '').toContain('Open findings re-checked: 1.');
  });
});

describe('runBotReview — whose open findings (ADR-0030)', () => {
  async function openFindingsSeenBy(params: { botSlot: number; consensus: boolean }): Promise<string> {
    const requests: ReviewModelRequest[] = [];
    const prFiles: PullRequestFile[] = [
      { path: 'svc/api/main.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: mainPatch },
      { path: 'svc/rate/limit.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: limitPatch },
    ];
    await runBotReview({
      ...base,
      client: makeClient([]),
      model: recordingModel(requests),
      botSlot: params.botSlot,
      ...(params.consensus
        ? { prFiles, selection: { mode: 'incremental' as const, files: [prFiles[0]!], sinceSha: lastHead } }
        : {}),
    });
    return requests[0]?.user ?? '';
  }

  it("shows a consensus bot slot 1's open findings: the panel publishes as slot 1", async () => {
    const user = await openFindingsSeenBy({ botSlot: 3, consensus: true });
    expect(user).toContain('Slot one finding');
    expect(user).not.toContain('Slot three finding');
  });

  it('shows a bot reviewing on its own its own open findings', async () => {
    const user = await openFindingsSeenBy({ botSlot: 3, consensus: false });
    expect(user).not.toContain('Slot one finding');
    expect(user).toContain('Slot three finding');
  });
});

describe('review thread reads in the App clients (ADR-0030)', () => {
  it('reads threads through the installation GraphQL and keeps the reader behind the write guard', async () => {
    const octokit = {
      graphql: async () => ({
        repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 9 }] } }] } } },
      }),
      rest: { pulls: {}, repos: {} },
    } as unknown as OctokitLike;
    const store = { getInstallation: async () => ({ workspaceId: 'w1' }) } as unknown as AppStore;
    const guarded = guardWritesForWorkspace(wrapOctokit(octokit), store, 1, 'w1');

    expect(await guarded.listReviewThreads?.({ owner: 'o', repo: 'r', pull_number: 1 })).toEqual([{ isResolved: false, firstCommentId: 9 }]);
  });
});

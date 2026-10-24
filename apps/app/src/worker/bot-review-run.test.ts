import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runReview,
  type MergePilotConfig,
  type RepositoryReader,
  type ReviewModel,
  type ReviewRunResult,
} from '@mergepilot/engine';
import { createRepositoryReader, type GitHubClient, type PullRequestFile } from '@mergepilot/github';
import { runBotReview, type BotReviewParams } from './bot-review-run.js';

vi.mock('@mergepilot/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/engine')>();
  return { ...actual, runReview: vi.fn() };
});

vi.mock('@mergepilot/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mergepilot/github')>();
  return { ...actual, createRepositoryReader: vi.fn() };
});

const exploration = { rounds: 1, requests: 1, filesRead: ['src/a.ts'], refused: 0 };
const reviewResult = {
  status: 'completed',
  exploration,
} as unknown as ReviewRunResult;
const reader = {} as unknown as RepositoryReader;
const prFiles: PullRequestFile[] = [
  { path: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new', changes: 2 },
];
const config: MergePilotConfig = {
  provider: 'anthropic',
  model: 'claude-x',
  language: 'en',
  review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: ['**/*.lock'], pathInstructions: [], instructions: [] },
  budget: { perReviewUsd: 1, maxInputTokens: 100_000 },
};
const model: ReviewModel = {
  label: 'anthropic:claude-x',
  generate: async () => ({ text: '', finishReason: 'stop' }),
};
const client = { getFileContent: async () => null } as unknown as GitHubClient;

function params(explore?: boolean): BotReviewParams {
  return {
    client,
    owner: 'acme',
    repo: 'repo',
    pullNumber: 7,
    headSha: 'head-sha',
    baseSha: 'base-sha',
    prTitle: 'Title',
    prBody: '',
    config,
    configHash: 'cfg',
    rulesFiles: [],
    model,
    prFiles,
    selection: { mode: 'full', files: prFiles, reason: 'first review' },
    explore,
  };
}

describe('runBotReview repository exploration (ADR-0046)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runReview).mockResolvedValue(reviewResult);
    vi.mocked(createRepositoryReader).mockReturnValue(reader);
  });

  it('passes a head reader only when explore is true and returns the disclosure', async () => {
    const enabled = await runBotReview(params(true));
    const disabled = await runBotReview(params(false));

    expect(createRepositoryReader).toHaveBeenCalledTimes(1);
    expect(createRepositoryReader).toHaveBeenCalledWith(client, {
      owner: 'acme',
      repo: 'repo',
      headSha: 'head-sha',
      exclude: config.review.exclude,
    });
    expect(vi.mocked(runReview).mock.calls[0]?.[0]).toMatchObject({ explore: { reader } });
    expect(vi.mocked(runReview).mock.calls[1]?.[0].explore).toBeUndefined();
    expect(enabled.kind === 'reviewed' && enabled.exploration).toEqual(exploration);
    expect(disabled.kind === 'reviewed' && disabled.exploration).toEqual(exploration);
  });
});

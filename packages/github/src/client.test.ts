import { describe, expect, it, vi } from 'vitest';
import { createOctokitClient } from './client.js';

// Mock @octokit/rest to avoid real network calls
const mockListFiles = vi.fn();
const mockGet = vi.fn();
const mockListReviews = vi.fn();
const mockCreateReview = vi.fn();

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      rest = {
        pulls: {
          listFiles: mockListFiles,
          get: mockGet,
          listReviews: mockListReviews,
          createReview: mockCreateReview,
        },
      };
    },
  };
});

describe('createOctokitClient', () => {
  const secretToken = 'sk-test-secret-token-123456';

  it('never leaks the token in any thrown error message', async () => {
    mockGet.mockRejectedValueOnce(
      new Error(`Request failed with status 401 using auth ${secretToken}`),
    );

    const client = createOctokitClient(secretToken);

    let caughtError: unknown;
    try {
      await client.getPullRequest({ owner: 'org', repo: 'repo', pull_number: 1 });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
    expect(msg).not.toContain(secretToken);
    expect(msg).toContain('[REDACTED]');
  });

  it('redacts token when listPullRequestFilesPage throws', async () => {
    mockListFiles.mockRejectedValueOnce(
      new Error(`Error with token: ${secretToken}`),
    );

    const client = createOctokitClient(secretToken);

    let caughtError: unknown;
    try {
      await client.listPullRequestFilesPage({
        owner: 'org',
        repo: 'repo',
        pull_number: 1,
        page: 1,
        per_page: 100,
      });
    } catch (err: unknown) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
    expect(msg).not.toContain(secretToken);
    expect(msg).toContain('[REDACTED]');
  });

  it('delegates listPullRequestFilesPage to octokit.rest.pulls.listFiles', async () => {
    const fakeData = [
      {
        filename: 'src/index.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
        changes: 10,
      },
    ];
    mockListFiles.mockResolvedValueOnce({ data: fakeData });

    const client = createOctokitClient(secretToken);
    const result = await client.listPullRequestFilesPage({
      owner: 'org',
      repo: 'repo',
      pull_number: 1,
      page: 1,
      per_page: 100,
    });

    expect(result).toEqual(fakeData);
    expect(mockListFiles).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 1,
      page: 1,
      per_page: 100,
    });
  });

  it('delegates getPullRequest to octokit.rest.pulls.get', async () => {
    const fakePr = { head: { sha: 'sha123' } };
    mockGet.mockResolvedValueOnce({ data: fakePr });

    const client = createOctokitClient(secretToken);
    const result = await client.getPullRequest({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
    });

    expect(result).toEqual(fakePr);
    expect(mockGet).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
    });
  });

  it('delegates listReviewsPage to octokit.rest.pulls.listReviews', async () => {
    const fakeReviews = [{ id: 1, body: 'review body' }];
    mockListReviews.mockResolvedValueOnce({ data: fakeReviews });

    const client = createOctokitClient(secretToken);
    const result = await client.listReviewsPage({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
      page: 1,
      per_page: 100,
    });

    expect(result).toEqual(fakeReviews);
    expect(mockListReviews).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
      page: 1,
      per_page: 100,
    });
  });

  it('delegates createReview to octokit.rest.pulls.createReview', async () => {
    mockCreateReview.mockResolvedValueOnce({ data: { id: 999 } });

    const client = createOctokitClient(secretToken);
    const result = await client.createReview({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
      commit_id: 'sha123',
      event: 'COMMENT',
      body: 'Review text',
    });

    expect(result).toEqual({ id: 999 });
    expect(mockCreateReview).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      pull_number: 5,
      commit_id: 'sha123',
      event: 'COMMENT',
      body: 'Review text',
    });
  });
});

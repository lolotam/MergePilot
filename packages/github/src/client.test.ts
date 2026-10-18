import { describe, expect, it, vi } from 'vitest';
import { createOctokitClient } from './client.js';

// Mock @octokit/rest to avoid real network calls
const mockListFiles = vi.fn();
const mockGet = vi.fn();
const mockListReviews = vi.fn();
const mockCreateReview = vi.fn();
const mockGetContent = vi.fn();
const mockCompareCommitsWithBasehead = vi.fn();
const mockGraphql = vi.fn();

vi.mock('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      graphql = mockGraphql;
      rest = {
        pulls: {
          listFiles: mockListFiles,
          get: mockGet,
          listReviews: mockListReviews,
          createReview: mockCreateReview,
        },
        repos: {
          getContent: mockGetContent,
          compareCommitsWithBasehead: mockCompareCommitsWithBasehead,
        },
      };
    },
  };
});

describe('createOctokitClient', () => {
  const secretToken = 'sk-test-secret-token-123456';

  it('reads review threads through GraphQL and redacts the token from its errors (ADR-0030)', async () => {
    const client = createOctokitClient(secretToken);
    mockGraphql.mockResolvedValueOnce({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 4 }] } }] } } },
    });
    expect(await client.listReviewThreads!({ owner: 'org', repo: 'repo', pull_number: 2 })).toEqual([{ isResolved: true, firstCommentId: 4 }]);

    mockGraphql.mockRejectedValueOnce(new Error(`GraphQL 401 for ${secretToken}`));
    const error = await client.listReviewThreads!({ owner: 'org', repo: 'repo', pull_number: 2 }).catch((e: unknown) => e);
    expect(String(error)).not.toContain(secretToken);
    expect(String(error)).toContain('[REDACTED]');
  });

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

  it('delegates getFileContent and decodes base64 content', async () => {
    const rawText = 'provider: anthropic\nmodel: claude-3-5-sonnet';
    const base64Text = Buffer.from(rawText, 'utf8').toString('base64');
    mockGetContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: base64Text,
      },
    });

    const client = createOctokitClient(secretToken);
    const result = await client.getFileContent({
      owner: 'org',
      repo: 'repo',
      path: '.mergepilot.yml',
      ref: 'main',
    });

    expect(result).toBe(rawText);
    expect(mockGetContent).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      path: '.mergepilot.yml',
      ref: 'main',
    });
  });

  it('returns null when getFileContent encounters a 404', async () => {
    const notFoundError = new Error('Not Found');
    (notFoundError as unknown as { status: number }).status = 404;
    mockGetContent.mockRejectedValueOnce(notFoundError);

    const client = createOctokitClient(secretToken);
    const result = await client.getFileContent({
      owner: 'org',
      repo: 'repo',
      path: 'nonexistent.yml',
      ref: 'main',
    });

    expect(result).toBeNull();
  });

  it('lists only the files of a directory, and null for a missing one or a file', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: [
        { path: '.github/workflows/ci.yml', type: 'file' },
        { path: '.github/workflows/shared', type: 'dir' },
      ],
    });
    const client = createOctokitClient(secretToken);
    const params = { owner: 'org', repo: 'repo', path: '.github/workflows', ref: 'head' };
    expect(await client.listDirectoryFiles!(params)).toEqual(['.github/workflows/ci.yml']);

    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    mockGetContent.mockRejectedValueOnce(notFound);
    expect(await client.listDirectoryFiles!(params)).toBeNull();

    mockGetContent.mockResolvedValueOnce({ data: { type: 'file', content: '' } });
    expect(await client.listDirectoryFiles!(params)).toBeNull();
  });

  it('returns null when getFileContent points to a directory', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: [
        { name: 'file1.ts', type: 'file' },
        { name: 'file2.ts', type: 'file' },
      ],
    });

    const client = createOctokitClient(secretToken);
    const result = await client.getFileContent({
      owner: 'org',
      repo: 'repo',
      path: 'src',
      ref: 'main',
    });

    expect(result).toBeNull();
  });

  it('redacts token when getFileContent throws non-404 error', async () => {
    const serverError = new Error(`Server error with token ${secretToken}`);
    (serverError as unknown as { status: number }).status = 500;
    mockGetContent.mockRejectedValueOnce(serverError);

    const client = createOctokitClient(secretToken);
    let caught: unknown;
    try {
      await client.getFileContent({
        owner: 'org',
        repo: 'repo',
        path: 'src/main.ts',
        ref: 'main',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).not.toContain(secretToken);
    expect(msg).toContain('[REDACTED]');
  });

  it('delegates compareCommits to octokit.rest.repos.compareCommitsWithBasehead', async () => {
    const fakeFiles = [
      { filename: 'src/main.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ -1 +1 @@' },
    ];
    mockCompareCommitsWithBasehead.mockResolvedValueOnce({ data: { status: 'ahead', files: fakeFiles } });

    const client = createOctokitClient(secretToken);
    const result = await client.compareCommits({ owner: 'org', repo: 'repo', base: 'sha-base', head: 'sha-head' });

    expect(result).toEqual({ status: 'ahead', files: fakeFiles });
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      basehead: 'sha-base...sha-head',
      page: 1,
      per_page: 100,
    });
  });

  it('paginates compareCommits when first page has 100 files', async () => {
    const page1Files = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    const page2Files = [
      { filename: 'src/file-100.ts', status: 'added', additions: 10, deletions: 0, changes: 10 },
    ];

    mockCompareCommitsWithBasehead
      .mockResolvedValueOnce({ data: { status: 'ahead', files: page1Files } })
      .mockResolvedValueOnce({ data: { status: 'ahead', files: page2Files } });

    const client = createOctokitClient(secretToken);
    const result = await client.compareCommits({ owner: 'org', repo: 'repo', base: 'sha-base', head: 'sha-head' });

    expect(result).toEqual({ status: 'ahead', files: [...page1Files, ...page2Files] });
    expect(mockCompareCommitsWithBasehead).toHaveBeenCalledTimes(2);
    expect(mockCompareCommitsWithBasehead).toHaveBeenNthCalledWith(1, {
      owner: 'org',
      repo: 'repo',
      basehead: 'sha-base...sha-head',
      page: 1,
      per_page: 100,
    });
    expect(mockCompareCommitsWithBasehead).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      basehead: 'sha-base...sha-head',
      page: 2,
      per_page: 100,
    });
  });

  it('returns null when compareCommits encounters a 404', async () => {
    const notFoundError = new Error('Not Found');
    (notFoundError as unknown as { status: number }).status = 404;
    mockCompareCommitsWithBasehead.mockRejectedValueOnce(notFoundError);

    const client = createOctokitClient(secretToken);
    const result = await client.compareCommits({ owner: 'org', repo: 'repo', base: 'force-pushed-base', head: 'sha-head' });

    expect(result).toBeNull();
  });

  it('redacts token when compareCommits throws a non-404 error', async () => {
    const serverError = new Error(`Server error with token ${secretToken}`);
    (serverError as unknown as { status: number }).status = 500;
    mockCompareCommitsWithBasehead.mockRejectedValueOnce(serverError);

    const client = createOctokitClient(secretToken);
    let caught: unknown;
    try {
      await client.compareCommits({ owner: 'org', repo: 'repo', base: 'sha-base', head: 'sha-head' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).not.toContain(secretToken);
    expect(msg).toContain('[REDACTED]');
  });
});

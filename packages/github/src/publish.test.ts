import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from './client.js';
import { buildMarker } from './marker.js';
import { publishReview } from './publish.js';

const mockFinding: Finding = {
  id: 'f-1',
  path: 'src/main.ts',
  line: 10,
  side: 'RIGHT',
  title: 'Buffer overflow risk',
  body: 'Buffer size is unvalidated.',
  severity: 'critical',
  category: 'security',
  evidence: 'const buf = Buffer.alloc(size);',
  suggestion: 'const buf = Buffer.alloc(Math.min(size, MAX_SIZE));',
  confidence: 0.99,
};

describe('publishReview', () => {
  it('stale head skips without createReview', async () => {
    const createReviewMock = vi.fn();
    const fakeClient: Partial<GitHubClient> = {
      async getPullRequest() {
        return { head: { sha: 'actual-new-head-sha' } };
      },
      createReview: createReviewMock,
    };

    const result = await publishReview(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 10,
      expectedHeadSha: 'expected-old-head-sha',
      summaryMarkdown: 'Summary text',
      inline: [mockFinding],
      configHash: 'conf-123',
      language: 'en',
      suggestionsAsCode: true,
      publisherLogin: 'github-actions[bot]',
    });

    expect(result).toEqual({ status: 'skipped-stale' });
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('duplicate marker skips without createReview', async () => {
    const headSha = 'head-sha-abc';
    const configHash = 'conf-hash-xyz';
    const marker = buildMarker({ headSha, configHash });

    const createReviewMock = vi.fn();
    const fakeClient: Partial<GitHubClient> = {
      async getPullRequest() {
        return { head: { sha: headSha } };
      },
      async listReviewsPage() {
        return [
          { id: 101, body: 'Some previous review without marker' },
          { id: 102, body: `LGTM\n\n${marker}`, user: { login: 'github-actions[bot]' } },
        ];
      },
      createReview: createReviewMock,
    };

    const result = await publishReview(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 10,
      expectedHeadSha: headSha,
      summaryMarkdown: 'Summary text',
      inline: [mockFinding],
      configHash,
      language: 'en',
      suggestionsAsCode: true,
      publisherLogin: 'github-actions[bot]',
    });

    expect(result).toEqual({ status: 'skipped-duplicate', reviewId: 102 });
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('publishes review with COMMENT event, commit_id set, summary+marker, and mapped comments', async () => {
    const headSha = 'sha-good-123';
    const configHash = 'conf-good-456';

    let capturedParams: CreateReviewParams | undefined;
    const fakeClient: Partial<GitHubClient> = {
      async getPullRequest() {
        return { head: { sha: headSha } };
      },
      async listReviewsPage() {
        return [];
      },
      async createReview(params) {
        capturedParams = params;
        return { id: 789 };
      },
    };

    const result = await publishReview(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 10,
      expectedHeadSha: headSha,
      summaryMarkdown: '## All clear',
      inline: [mockFinding],
      configHash,
      language: 'en',
      suggestionsAsCode: true,
      publisherLogin: 'github-actions[bot]',
    });

    expect(result).toEqual({ status: 'published', reviewId: 789 });
    expect(capturedParams).toBeDefined();
    expect(capturedParams?.event).toBe('COMMENT');
    expect(capturedParams?.commit_id).toBe(headSha);
    expect(capturedParams?.owner).toBe('acme');
    expect(capturedParams?.repo).toBe('repo');
    expect(capturedParams?.pull_number).toBe(10);

    // Body contains summary and hidden marker
    expect(capturedParams?.body).toContain('## All clear');
    expect(capturedParams?.body).toContain(buildMarker({ headSha, configHash }));

    // Inline comments mapped to path, line, side, body
    expect(capturedParams?.comments).toHaveLength(1);
    const comment = capturedParams?.comments?.[0];
    expect(comment?.path).toBe('src/main.ts');
    expect(comment?.line).toBe(10);
    expect(comment?.side).toBe('RIGHT');
    expect(comment?.body).toContain('Buffer overflow risk');
    expect(comment?.body).toContain('```suggestion');
  });

  it('checks all review pages to find duplicate marker on subsequent pages', async () => {
    const headSha = 'sha-duplicate-page-2';
    const configHash = 'conf-dup';
    const marker = buildMarker({ headSha, configHash });

    const fakeClient: Partial<GitHubClient> = {
      async getPullRequest() {
        return { head: { sha: headSha } };
      },
      async listReviewsPage({ page }) {
        if (page === 1) {
          return Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            body: 'Review without marker',
          }));
        }
        if (page === 2) {
          return [{ id: 555, body: `Existing review\n${marker}`, user: { login: 'github-actions[bot]' } }];
        }
        return [];
      },
      async createReview() {
        throw new Error('Should not be called');
      },
    };

    const result = await publishReview(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 10,
      expectedHeadSha: headSha,
      summaryMarkdown: 'Summary',
      inline: [],
      configHash,
      language: 'en',
      suggestionsAsCode: true,
      publisherLogin: 'github-actions[bot]',
    });

    expect(result).toEqual({ status: 'skipped-duplicate', reviewId: 555 });
  });

  it('ignores a marker posted by another account and still publishes', async () => {
    const headSha = 'sha-forged';
    const configHash = 'conf-forged';
    const createReview = vi.fn(async () => ({ id: 901 }));
    const fakeClient: Partial<GitHubClient> = {
      async getPullRequest() {
        return { head: { sha: headSha } };
      },
      async listReviewsPage() {
        return [{ id: 7, body: buildMarker({ headSha, configHash }), user: { login: 'pr-author' } }];
      },
      createReview,
    };

    const result = await publishReview(fakeClient as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 10,
      expectedHeadSha: headSha,
      summaryMarkdown: 'Summary',
      inline: [],
      configHash,
      language: 'en',
      suggestionsAsCode: false,
      publisherLogin: 'github-actions[bot]',
    });

    expect(result).toEqual({ status: 'published', reviewId: 901 });
    expect(createReview).toHaveBeenCalledOnce();
  });
});

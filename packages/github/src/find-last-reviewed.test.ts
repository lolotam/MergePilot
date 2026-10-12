import { describe, expect, it } from 'vitest';
import type { GitHubClient, GitHubReview } from './client.js';
import { buildMarker } from './marker.js';
import { findLastReviewedHead, findLastReviewedMarker } from './incremental.js';

describe('findLastReviewedHead', () => {
  const publisherLogin = 'github-actions[bot]';

  it('returns null when there are no reviews on the PR', async () => {
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('returns null when reviews exist but none have markers', async () => {
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 1, user: { login: publisherLogin }, body: 'LGTM without marker' },
          { id: 2, user: { login: publisherLogin }, body: null },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('ignores markers from other authors', async () => {
    const foreignMarker = buildMarker({ headSha: 'sha-foreign', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 1, user: { login: 'contributor' }, body: `Review comment\n${foreignMarker}` },
          { id: 2, user: { login: 'someone-else' }, body: foreignMarker },
          { id: 3, user: null, body: foreignMarker },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBeNull();
  });

  it('returns the head SHA from the marker of our review', async () => {
    const ourMarker = buildMarker({ headSha: 'sha-valid-123', configHash: 'conf-1' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: `Review summary\n\n${ourMarker}` }];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBe('sha-valid-123');
  });

  it('picks the most recent of several of our reviews', async () => {
    const marker1 = buildMarker({ headSha: 'sha-old-1', configHash: 'conf-1' });
    const marker2 = buildMarker({ headSha: 'sha-new-2', configHash: 'conf-2' });
    const foreignMarker = buildMarker({ headSha: 'sha-foreign-3', configHash: 'conf-3' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [
          { id: 10, user: { login: publisherLogin }, body: `First review\n${marker1}` },
          { id: 11, user: { login: 'other-user' }, body: `Other review\n${foreignMarker}` },
          { id: 12, user: { login: publisherLogin }, body: `Second review\n${marker2}` },
        ];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBe('sha-new-2');
  });

  it('paginates across multiple pages to find the most recent review on a later page', async () => {
    const markerPage1 = buildMarker({ headSha: 'sha-page-1', configHash: 'conf-1' });
    const markerPage2 = buildMarker({ headSha: 'sha-page-2', configHash: 'conf-2' });

    const client: Partial<GitHubClient> = {
      async listReviewsPage({ page }) {
        if (page === 1) {
          const reviews: GitHubReview[] = Array.from({ length: 99 }, (_, i) => ({
            id: i + 1,
            user: { login: 'random-user' },
            body: 'Random comment',
          }));
          reviews.push({ id: 100, user: { login: publisherLogin }, body: markerPage1 });
          return reviews;
        }
        if (page === 2) {
          return [{ id: 201, user: { login: publisherLogin }, body: `Latest review\n${markerPage2}` }];
        }
        return [];
      },
    };
    const result = await findLastReviewedHead(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toBe('sha-page-2');
  });

  it('extracts headSha and configHash in findLastReviewedMarker', async () => {
    const marker = buildMarker({ headSha: 'sha-abc', configHash: 'cfg-xyz' });
    const client: Partial<GitHubClient> = {
      async listReviewsPage() {
        return [{ id: 1, user: { login: publisherLogin }, body: marker }];
      },
    };
    const result = await findLastReviewedMarker(client as GitHubClient, {
      owner: 'acme',
      repo: 'repo',
      pull_number: 1,
      publisherLogin,
    });
    expect(result).toEqual({ headSha: 'sha-abc', configHash: 'cfg-xyz' });
  });
});

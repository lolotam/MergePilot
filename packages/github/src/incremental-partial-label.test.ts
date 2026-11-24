import { expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { selectIncrementalFiles } from './incremental.js';
import { buildMarker, type ReviewMarker } from './marker.js';

const publisherLogin = 'reviewer[bot]';
const options = {
  owner: 'example', repo: 'archive', pull_number: 1, headSha: 'new-head',
  publisherLogin, prFiles: [], botSlot: 2,
};

function reviewClient(markers: Array<Omit<ReviewMarker, 'configHash'>>) {
  const compareCommits = vi.fn<GitHubClient['compareCommits']>().mockResolvedValue({ status: 'ahead', files: [] });
  const client: Pick<GitHubClient, 'listReviewsPage' | 'compareCommits'> = {
    async listReviewsPage() {
      return markers.map((marker, id) => ({
        id, user: { login: publisherLogin }, body: buildMarker({ ...marker, configHash: 'config' }),
      }));
    },
    compareCommits,
  };
  return { client: client as GitHubClient, compareCommits };
}

it.each([
  ['only partial markers for this bot', [{ headSha: 'partial-head', bot: 2, status: 'partial' }], 'previous review was incomplete'],
  ['no markers', [], 'first review'],
  ['a partial marker for a different bot', [{ headSha: 'other-head', bot: 3, status: 'partial' }], 'first review'],
] satisfies Array<[string, Array<Omit<ReviewMarker, 'configHash'>>, string]>)(
  'labels a full review with %s',
  async (_scenario, markers, reason) => {
    const { client, compareCommits } = reviewClient(markers);
    await expect(selectIncrementalFiles(client, options)).resolves.toEqual({ mode: 'full', files: [], reason });
    expect(compareCommits).not.toHaveBeenCalled();
  },
);

it('still uses an older complete review when a later review was partial', async () => {
  const { client, compareCommits } = reviewClient([
    { headSha: 'complete-head', bot: 2 },
    { headSha: 'partial-head', bot: 2, status: 'partial' },
  ]);
  await expect(selectIncrementalFiles(client, options)).resolves.toEqual({
    mode: 'incremental', files: [], sinceSha: 'complete-head',
  });
  expect(compareCommits).toHaveBeenCalledWith({
    owner: options.owner, repo: options.repo, base: 'complete-head', head: options.headSha,
  });
});
